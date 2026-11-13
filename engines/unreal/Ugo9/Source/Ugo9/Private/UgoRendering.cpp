/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// Drawing Ugo9 characters: a scene view extension that, after the scene's translucency and before
// post-processing, draws each model's characters into the scene colour (tested against the
// scene's depth) with one instanced draw: no vertex buffer, the shader (Shaders/Private/Ugo9.usf)
// reads the model's tables and the characters' frame blocks.
// Stage 2: a draw per run of parts sharing a blend class (normal, multiply, screen), up to 8 atlas
// pages, characters grouped by their draw order (format 0.8), and the model's tables kept on the
// GPU between frames (only the characters' frame blocks go up each frame).
// Stage 3: masks. Before a model's characters are drawn, each character's mask parts are drawn
// into its mask images (a texture array over the model's canvas: one slice per character and 4
// mask channels, cleared, overlaps by max), which the characters' parts then read.
#include "UgoWorldSubsystem.h"

#include "CommonRenderResources.h"
#include "Engine/Texture2D.h"
#include "GlobalShader.h"
#include "PostProcess/PostProcessInputs.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "SceneRendering.h"
#include "SceneView.h"
#include "SceneViewExtension.h"
#include "ShaderParameterStruct.h"
#include "TextureResource.h"
#include "UgoCharacterComponent.h"
#include "UgoModelAsset.h"

BEGIN_SHADER_PARAMETER_STRUCT(FUgoDrawParameters, )
	SHADER_PARAMETER(FMatrix44f, WorldToClip)
	SHADER_PARAMETER(float, UnitsPerPixel)
	SHADER_PARAMETER(uint32, SkinT)
	SHADER_PARAMETER(uint32, OpF)
	SHADER_PARAMETER(uint32, MorphF)
	SHADER_PARAMETER(uint32, ColorF)
	SHADER_PARAMETER(uint32, Stride)
	SHADER_PARAMETER(uint32, InstanceBase)
	SHADER_PARAMETER(FVector4f, Canvas)
	SHADER_PARAMETER(uint32, MaskGroups)
	SHADER_PARAMETER(uint32, MaskGroup)
	SHADER_PARAMETER_RDG_BUFFER_SRV(StructuredBuffer<uint>, Indices)
	SHADER_PARAMETER_RDG_BUFFER_SRV(StructuredBuffer<float4>, Positions)
	SHADER_PARAMETER_RDG_BUFFER_SRV(StructuredBuffer<float4>, Vertices)
	SHADER_PARAMETER_RDG_BUFFER_SRV(StructuredBuffer<float4>, Entries)
	SHADER_PARAMETER_RDG_BUFFER_SRV(StructuredBuffer<float4>, XWeights)
	SHADER_PARAMETER_RDG_BUFFER_SRV(StructuredBuffer<float4>, Parts)
	SHADER_PARAMETER_RDG_BUFFER_SRV(StructuredBuffer<float4>, Frames)
	SHADER_PARAMETER_RDG_BUFFER_SRV(StructuredBuffer<float4>, Depths)
	SHADER_PARAMETER_TEXTURE(Texture2D, Atlas0)
	SHADER_PARAMETER_TEXTURE(Texture2D, Atlas1)
	SHADER_PARAMETER_TEXTURE(Texture2D, Atlas2)
	SHADER_PARAMETER_TEXTURE(Texture2D, Atlas3)
	SHADER_PARAMETER_TEXTURE(Texture2D, Atlas4)
	SHADER_PARAMETER_TEXTURE(Texture2D, Atlas5)
	SHADER_PARAMETER_TEXTURE(Texture2D, Atlas6)
	SHADER_PARAMETER_TEXTURE(Texture2D, Atlas7)
	SHADER_PARAMETER_SAMPLER(SamplerState, AtlasSampler)
	SHADER_PARAMETER_RDG_TEXTURE(Texture2DArray, Mask)
	SHADER_PARAMETER_SAMPLER(SamplerState, MaskSampler)
	RENDER_TARGET_BINDING_SLOTS()
END_SHADER_PARAMETER_STRUCT()

class FUgoVS : public FGlobalShader
{
	DECLARE_GLOBAL_SHADER(FUgoVS);
	SHADER_USE_PARAMETER_STRUCT(FUgoVS, FGlobalShader);
	using FParameters = FUgoDrawParameters;
	static bool ShouldCompilePermutation(const FGlobalShaderPermutationParameters &P) { return IsFeatureLevelSupported(P.Platform, ERHIFeatureLevel::SM5); }
};
class FUgoPS : public FGlobalShader
{
	DECLARE_GLOBAL_SHADER(FUgoPS);
	SHADER_USE_PARAMETER_STRUCT(FUgoPS, FGlobalShader);
	using FParameters = FUgoDrawParameters;
	static bool ShouldCompilePermutation(const FGlobalShaderPermutationParameters &P) { return IsFeatureLevelSupported(P.Platform, ERHIFeatureLevel::SM5); }
};
IMPLEMENT_GLOBAL_SHADER(FUgoVS, "/Plugin/Ugo9/Private/Ugo9.usf", "MainVS", SF_Vertex);
IMPLEMENT_GLOBAL_SHADER(FUgoPS, "/Plugin/Ugo9/Private/Ugo9.usf", "MainPS", SF_Pixel);

// the mask pass (the same parameters; Mask is a dummy there)
class FUgoMaskVS : public FGlobalShader
{
	DECLARE_GLOBAL_SHADER(FUgoMaskVS);
	SHADER_USE_PARAMETER_STRUCT(FUgoMaskVS, FGlobalShader);
	using FParameters = FUgoDrawParameters;
	static bool ShouldCompilePermutation(const FGlobalShaderPermutationParameters &P) { return IsFeatureLevelSupported(P.Platform, ERHIFeatureLevel::SM5); }
};
class FUgoMaskPS : public FGlobalShader
{
	DECLARE_GLOBAL_SHADER(FUgoMaskPS);
	SHADER_USE_PARAMETER_STRUCT(FUgoMaskPS, FGlobalShader);
	using FParameters = FUgoDrawParameters;
	static bool ShouldCompilePermutation(const FGlobalShaderPermutationParameters &P) { return IsFeatureLevelSupported(P.Platform, ERHIFeatureLevel::SM5); }
};
IMPLEMENT_GLOBAL_SHADER(FUgoMaskVS, "/Plugin/Ugo9/Private/Ugo9.usf", "MaskVS", SF_Vertex);
IMPLEMENT_GLOBAL_SHADER(FUgoMaskPS, "/Plugin/Ugo9/Private/Ugo9.usf", "MaskPS", SF_Pixel);

static constexpr int32 UgoMaxPages = 8;

// characters of one model sharing a draw order, back to back in the model's frame blocks
struct FUgoGroup
{
	uint32 Key = 0;        // 0: the stored order
	TArray<uint32> Order;  // part numbers in drawing order (empty for key 0)
	int32 First = 0, Count = 0;
};

// one model's characters this frame, handed to the render thread
struct FUgoBatch
{
	TSharedPtr<const ugo9core::Model> Model;
	TArray<FVector4f> Frames; // Stride texels per character
	TArray<FVector4f> Depths;
	TArray<FUgoGroup> Groups;
	int32 Count = 0;
	uint32 Stride = 0;
	float UnitsPerPixel = 1.0f;
	FTextureResource *Atlases[UgoMaxPages] = {};
};

// a draw order's triangles: one index buffer, a run per blend class change
struct FUgoRunRange
{
	ugo9core::GpuTables::BlendClass Blend = ugo9core::GpuTables::Normal;
	uint32 First = 0, Count = 0; // indices
};
struct FUgoIndexSet
{
	TRefCountPtr<FRDGPooledBuffer> Indices;
	TArray<FUgoRunRange> Runs;
};

// a model's tables on the GPU, kept between frames (render thread)
struct FUgoModelGpu
{
	TSharedPtr<const ugo9core::Model> Keep; // the model stays alive while its buffers do
	TRefCountPtr<FRDGPooledBuffer> Positions, Vertices, Entries, XWeights, Parts, MaskIndices;
	TMap<uint32, FUgoIndexSet> Orders;
	uint64 LastUsed = 0;
};

static FRDGBufferRef UgoUpload(FRDGBuilder &GraphBuilder, const TCHAR *Name, const void *Data, int32 Count, uint32 Size)
{
	static const FVector4f Zero(0, 0, 0, 0);
	const bool Empty = Count == 0;
	return CreateStructuredBuffer(GraphBuilder, Name, Size, Empty ? 1 : Count, Empty ? (const void *)&Zero : Data, Size * (Empty ? 1 : Count));
}

static FRDGBufferRef UgoKeep(FRDGBuilder &GraphBuilder, TRefCountPtr<FRDGPooledBuffer> &Pooled, const TCHAR *Name, const void *Data, int32 Count, uint32 Size)
{
	if (Pooled.IsValid()) return GraphBuilder.RegisterExternalBuffer(Pooled);
	FRDGBufferRef B = UgoUpload(GraphBuilder, Name, Data, Count, Size);
	Pooled = ConvertToExternalBuffer(GraphBuilder, B);
	return B;
}

class FUgoViewExtension : public FWorldSceneViewExtension
{
public:
	FUgoViewExtension(const FAutoRegister &AutoRegister, UWorld *InWorld, UUgoWorldSubsystem *InOwner)
		: FWorldSceneViewExtension(AutoRegister, InWorld), Owner(InOwner) {}

	virtual void SetupViewFamily(FSceneViewFamily &) override {}
	virtual void SetupView(FSceneViewFamily &, FSceneView &) override {}

	// game thread, once a frame: the characters' frame blocks by model, grouped by draw order
	virtual void BeginRenderViewFamily(FSceneViewFamily &) override
	{
		TArray<FUgoBatch> Batches;
		int32 Characters = 0;
		if (UUgoWorldSubsystem *S = Owner.Get())
		{
			TArray<TSharedPtr<const ugo9core::Model>> Models;
			TArray<TArray<UUgoCharacterComponent *>> ByModel;
			for (const TWeakObjectPtr<UUgoCharacterComponent> &W : S->GetCharacters())
			{
				UUgoCharacterComponent *C = W.Get();
				if (!C || !C->IsVisible() || !C->HasFrame() || !C->Model) continue;
				TSharedPtr<const ugo9core::Model> M = C->Model->CoreShared();
				if (!M.IsValid() || (uint32)C->LastFrame().Num() != M->FrameFloats()) continue;
				int32 At = Models.IndexOfByKey(M);
				if (At == INDEX_NONE) { At = Models.Add(M); ByModel.AddDefaulted(); }
				ByModel[At].Add(C);
			}
			for (int32 m = 0; m < Models.Num(); m++)
			{
				TArray<UUgoCharacterComponent *> &List = ByModel[m];
				List.StableSort([](const UUgoCharacterComponent &A, const UUgoCharacterComponent &B) { return A.LastDrawOrderKey() < B.LastDrawOrderKey(); });
				FUgoBatch &B = Batches.AddDefaulted_GetRef();
				B.Model = Models[m];
				B.Model->Tables(); // made here, read on the render thread
				B.Stride = (B.Model->FrameFloats() + 3) / 4;
				B.UnitsPerPixel = List[0]->Model->UnitsPerPixel;
				const int32 Pages = FMath::Clamp(B.Model->Tables().textureCount, 1, UgoMaxPages);
				for (int32 i = 0; i < Pages; i++)
				{
					UTexture2D *T = List[0]->Model->GetAtlasTexture(i);
					B.Atlases[i] = T ? T->GetResource() : nullptr;
				}
				B.Frames.SetNumZeroed(B.Stride * List.Num());
				for (UUgoCharacterComponent *C : List)
				{
					const uint32 Key = C->LastDrawOrderKey();
					if (B.Groups.Num() == 0 || B.Groups.Last().Key != Key)
					{
						FUgoGroup &G = B.Groups.AddDefaulted_GetRef();
						G.Key = Key;
						if (Key != 0) G.Order = C->LastDrawOrder();
						G.First = B.Count;
					}
					B.Groups.Last().Count++;
					FMemory::Memcpy(&B.Frames[B.Count * B.Stride], C->LastFrame().GetData(), C->LastFrame().Num() * sizeof(float));
					B.Depths.Add(FVector4f(C->LastDepth(), 0, 0, 0));
					B.Count++;
				}
				Characters += B.Count;
			}
			S->LastCharacters = Characters;
			S->LastDraws = LastDraws; // (the frame before)
			S->LastModels = LastModels;
		}
		ENQUEUE_RENDER_COMMAND(Ugo9Frames)([this, Batches = MoveTemp(Batches)](FRHICommandListImmediate &) mutable { RenderBatches = MoveTemp(Batches); });
	}

	// render thread: after translucency, before post-processing
	virtual void PrePostProcessPass_RenderThread(FRDGBuilder &GraphBuilder, const FSceneView &View, const FPostProcessingInputs &Inputs) override
	{
		Frame++;
		ForgetUnused();
		if (RenderBatches.Num() == 0 || !Inputs.SceneTextures) return;
		FRDGTextureRef SceneColor = Inputs.SceneTextures->GetParameters()->SceneColorTexture;
		FRDGTextureRef SceneDepth = Inputs.SceneTextures->GetParameters()->SceneDepthTexture;
		const FIntRect Rect = static_cast<const FViewInfo &>(View).ViewRect;
		const FMatrix44f WorldToClip(View.ViewMatrices.GetViewProjectionMatrix());
		FGlobalShaderMap *Shaders = GetGlobalShaderMap(View.GetFeatureLevel());
		TShaderMapRef<FUgoVS> VS(Shaders);
		TShaderMapRef<FUgoPS> PS(Shaders);
		TShaderMapRef<FUgoMaskVS> MaskVS(Shaders);
		TShaderMapRef<FUgoMaskPS> MaskPS(Shaders);
		int32 Draws = 0, Models = 0;
		// bound where no mask images are read (models without masks, and the mask pass itself)
		FRDGTextureRef NoMasks = GraphBuilder.CreateTexture(FRDGTextureDesc::Create2DArray(FIntPoint(1, 1), PF_R8G8B8A8, FClearValueBinding::Transparent,
			TexCreate_RenderTargetable | TexCreate_ShaderResource, 1), TEXT("Ugo9.NoMasks"));
		AddClearRenderTargetPass(GraphBuilder, NoMasks, FLinearColor::Transparent);

		for (const FUgoBatch &B : RenderBatches)
		{
			if (B.Count == 0 || !B.Atlases[0] || !B.Atlases[0]->TextureRHI) continue;
			const ugo9core::GpuTables &T = B.Model->Tables();
			FUgoModelGpu &G = Gpu.FindOrAdd(B.Model.Get());
			G.Keep = B.Model;
			G.LastUsed = Frame;

			// the model's tables: up once, kept
			FRDGBufferRef Positions;
			if (!G.Positions.IsValid())
			{
				const int32 NV = (int32)(T.positions.size() / 2);
				TArray<FVector4f> P4;
				P4.SetNumUninitialized(NV);
				for (int32 i = 0; i < NV; i++) P4[i] = FVector4f(T.positions[2 * i], T.positions[2 * i + 1], T.uvs[2 * i], T.uvs[2 * i + 1]);
				Positions = UgoKeep(GraphBuilder, G.Positions, TEXT("Ugo9.Positions"), P4.GetData(), P4.Num(), sizeof(FVector4f));
			}
			else Positions = GraphBuilder.RegisterExternalBuffer(G.Positions);
			FRDGBufferRef Vertices = UgoKeep(GraphBuilder, G.Vertices, TEXT("Ugo9.Vertices"), T.vertices.data(), (int32)(T.vertices.size() / 4), sizeof(FVector4f));
			FRDGBufferRef Entries = UgoKeep(GraphBuilder, G.Entries, TEXT("Ugo9.Entries"), T.entries.data(), (int32)(T.entries.size() / 4), sizeof(FVector4f));
			FRDGBufferRef XWeights = UgoKeep(GraphBuilder, G.XWeights, TEXT("Ugo9.XWeights"), T.xweights.data(), (int32)(T.xweights.size() / 4), sizeof(FVector4f));
			FRDGBufferRef Parts = UgoKeep(GraphBuilder, G.Parts, TEXT("Ugo9.Parts"), T.parts.data(), (int32)(T.parts.size() / 4), sizeof(FVector4f));
			// the characters: every frame
			FRDGBufferSRVRef Frames = GraphBuilder.CreateSRV(UgoUpload(GraphBuilder, TEXT("Ugo9.Frames"), B.Frames.GetData(), B.Frames.Num(), sizeof(FVector4f)));
			FRDGBufferSRVRef Depths = GraphBuilder.CreateSRV(UgoUpload(GraphBuilder, TEXT("Ugo9.Depths"), B.Depths.GetData(), B.Depths.Num(), sizeof(FVector4f)));
			FRHITexture *Pages[UgoMaxPages];
			for (int32 i = 0; i < UgoMaxPages; i++)
				Pages[i] = B.Atlases[i] && B.Atlases[i]->TextureRHI ? B.Atlases[i]->TextureRHI.GetReference() : B.Atlases[0]->TextureRHI.GetReference();
			Models++;
			float Canvas[4];
			B.Model->Canvas(Canvas);
			const uint32 MaskGroups = (uint32)(T.maskChannels + 3) / 4;
			// the values every draw of this model shares
			auto Fill = [&](FUgoDrawParameters *P) {
				P->WorldToClip = WorldToClip;
				P->UnitsPerPixel = B.UnitsPerPixel;
				P->SkinT = T.skinOffset / 4;
				P->OpF = T.opacityOffset;
				P->MorphF = T.morphOffset;
				P->ColorF = T.colorOffset;
				P->Stride = B.Stride;
				P->Canvas = FVector4f(Canvas[0], Canvas[1], Canvas[2], Canvas[3]);
				P->MaskGroups = MaskGroups;
				P->Positions = GraphBuilder.CreateSRV(Positions);
				P->Vertices = GraphBuilder.CreateSRV(Vertices);
				P->Entries = GraphBuilder.CreateSRV(Entries);
				P->XWeights = GraphBuilder.CreateSRV(XWeights);
				P->Parts = GraphBuilder.CreateSRV(Parts);
				P->Frames = Frames;
				P->Depths = Depths;
				P->Atlas0 = Pages[0]; P->Atlas1 = Pages[1]; P->Atlas2 = Pages[2]; P->Atlas3 = Pages[3];
				P->Atlas4 = Pages[4]; P->Atlas5 = Pages[5]; P->Atlas6 = Pages[6]; P->Atlas7 = Pages[7];
				P->AtlasSampler = TStaticSamplerState<SF_Bilinear, AM_Clamp, AM_Clamp, AM_Clamp>::GetRHI();
				P->Mask = NoMasks;
				P->MaskSampler = TStaticSamplerState<SF_Bilinear, AM_Clamp, AM_Clamp, AM_Clamp>::GetRHI();
			};

			// each character's mask images
			FRDGTextureRef Masks = NoMasks;
			if (MaskGroups > 0 && T.maskIndices.size() >= 3 && Canvas[0] >= 1 && Canvas[1] >= 1)
			{
				const FIntPoint Size(FMath::Min((int32)Canvas[0], 4096), FMath::Min((int32)Canvas[1], 4096));
				// (an array has at most 2048 slices: characters past that read the last one)
				const int32 Slices = FMath::Min(B.Count * (int32)MaskGroups, 2048);
				Masks = GraphBuilder.CreateTexture(FRDGTextureDesc::Create2DArray(Size, PF_R8G8B8A8, FClearValueBinding::Transparent,
					TexCreate_RenderTargetable | TexCreate_ShaderResource, Slices), TEXT("Ugo9.Masks"));
				FRDGBufferSRVRef MaskIndices = GraphBuilder.CreateSRV(UgoKeep(GraphBuilder, G.MaskIndices, TEXT("Ugo9.MaskIndices"),
					T.maskIndices.data(), (int32)T.maskIndices.size(), sizeof(uint32)));
				const uint32 MaskTriangles = (uint32)T.maskIndices.size() / 3;
				for (int32 i = 0; (i + 1) * (int32)MaskGroups <= Slices; i++)
				{
					for (uint32 g = 0; g < MaskGroups; g++)
					{
						FUgoDrawParameters *P = GraphBuilder.AllocParameters<FUgoDrawParameters>();
						Fill(P);
						P->InstanceBase = (uint32)i;
						P->MaskGroup = g;
						P->Indices = MaskIndices;
						P->RenderTargets[0] = FRenderTargetBinding(Masks, ERenderTargetLoadAction::EClear, 0, (int16)(i * (int32)MaskGroups + (int32)g));
						GraphBuilder.AddPass(RDG_EVENT_NAME("Ugo9 masks"), P, ERDGPassFlags::Raster,
							[P, MaskVS, MaskPS, Size, MaskTriangles](FRHICommandList &RHICmdList) {
								RHICmdList.SetViewport(0, 0, 0.0f, Size.X, Size.Y, 1.0f);
								FGraphicsPipelineStateInitializer Pso;
								RHICmdList.ApplyCachedRenderTargets(Pso);
								// overlapping mask parts: the larger coverage
								Pso.BlendState = TStaticBlendState<CW_RGBA, BO_Max, BF_One, BF_One, BO_Max, BF_One, BF_One>::GetRHI();
								Pso.RasterizerState = TStaticRasterizerState<FM_Solid, CM_None>::GetRHI();
								Pso.DepthStencilState = TStaticDepthStencilState<false, CF_Always>::GetRHI();
								Pso.BoundShaderState.VertexDeclarationRHI = GEmptyVertexDeclaration.VertexDeclarationRHI;
								Pso.BoundShaderState.VertexShaderRHI = MaskVS.GetVertexShader();
								Pso.BoundShaderState.PixelShaderRHI = MaskPS.GetPixelShader();
								Pso.PrimitiveType = PT_TriangleList;
								SetGraphicsPipelineState(RHICmdList, Pso, 0);
								SetShaderParameters(RHICmdList, MaskVS, MaskVS.GetVertexShader(), *P);
								SetShaderParameters(RHICmdList, MaskPS, MaskPS.GetPixelShader(), *P);
								RHICmdList.DrawPrimitive(0, MaskTriangles, 1);
							});
						Draws++;
					}
				}
			}

			for (const FUgoGroup &Group : B.Groups)
			{
				FUgoIndexSet &Set = IndicesFor(GraphBuilder, G, *B.Model, Group);
				if (Set.Runs.Num() == 0) continue;
				FUgoDrawParameters *P = GraphBuilder.AllocParameters<FUgoDrawParameters>();
				Fill(P);
				P->InstanceBase = (uint32)Group.First;
				P->Indices = GraphBuilder.CreateSRV(GraphBuilder.RegisterExternalBuffer(Set.Indices));
				P->Mask = Masks;
				P->RenderTargets[0] = FRenderTargetBinding(SceneColor, ERenderTargetLoadAction::ELoad);
				P->RenderTargets.DepthStencil = FDepthStencilBinding(SceneDepth, ERenderTargetLoadAction::ELoad, FExclusiveDepthStencil::DepthRead_StencilNop);

				const TArray<FUgoRunRange> Runs = Set.Runs;
				const uint32 Instances = (uint32)Group.Count;
				GraphBuilder.AddPass(RDG_EVENT_NAME("Ugo9 characters"), P, ERDGPassFlags::Raster,
					[P, VS, PS, Rect, Runs, Instances](FRHICommandList &RHICmdList) {
						RHICmdList.SetViewport(Rect.Min.X, Rect.Min.Y, 0.0f, Rect.Max.X, Rect.Max.Y, 1.0f);
						for (const FUgoRunRange &R : Runs)
						{
							FGraphicsPipelineStateInitializer Pso;
							RHICmdList.ApplyCachedRenderTargets(Pso);
							Pso.BlendState = BlendFor(R.Blend);
							Pso.RasterizerState = TStaticRasterizerState<FM_Solid, CM_None>::GetRHI();
							// tested against the scene's depth (reversed Z), not written
							Pso.DepthStencilState = TStaticDepthStencilState<false, CF_DepthNearOrEqual>::GetRHI();
							Pso.BoundShaderState.VertexDeclarationRHI = GEmptyVertexDeclaration.VertexDeclarationRHI;
							Pso.BoundShaderState.VertexShaderRHI = VS.GetVertexShader();
							Pso.BoundShaderState.PixelShaderRHI = PS.GetPixelShader();
							Pso.PrimitiveType = PT_TriangleList;
							SetGraphicsPipelineState(RHICmdList, Pso, 0);
							SetShaderParameters(RHICmdList, VS, VS.GetVertexShader(), *P);
							SetShaderParameters(RHICmdList, PS, PS.GetPixelShader(), *P);
							// the shader reads Indices[SV_VertexID], and SV_VertexID counts from the base vertex
							RHICmdList.DrawPrimitive(R.First, R.Count / 3, Instances);
						}
					});
				Draws += Set.Runs.Num();
			}
		}
		LastDraws = Draws;
		LastModels = Models;
	}

	// premultiplied colour: normal (and add) over, multiply, screen
	static FRHIBlendState *BlendFor(ugo9core::GpuTables::BlendClass Blend)
	{
		switch (Blend)
		{
		case ugo9core::GpuTables::Multiply:
			return TStaticBlendState<CW_RGBA, BO_Add, BF_DestColor, BF_InverseSourceAlpha, BO_Add, BF_Zero, BF_One>::GetRHI();
		case ugo9core::GpuTables::Screen:
			return TStaticBlendState<CW_RGBA, BO_Add, BF_One, BF_InverseSourceColor, BO_Add, BF_One, BF_InverseSourceAlpha>::GetRHI();
		default:
			return TStaticBlendState<CW_RGBA, BO_Add, BF_One, BF_InverseSourceAlpha, BO_Add, BF_One, BF_InverseSourceAlpha>::GetRHI();
		}
	}

	// the triangles of a draw order, made once per order and kept
	FUgoIndexSet &IndicesFor(FRDGBuilder &GraphBuilder, FUgoModelGpu &G, const ugo9core::Model &M, const FUgoGroup &Group)
	{
		if (FUgoIndexSet *Found = G.Orders.Find(Group.Key)) return *Found;
		if (G.Orders.Num() >= 256) G.Orders.Reset(); // a model with very many orders: start over
		FUgoIndexSet &Set = G.Orders.Add(Group.Key);
		const bool Stored = Group.Key == 0 || Group.Order.Num() == 0;
		const std::vector<ugo9core::GpuTables::Run> Runs = Stored ? M.Tables().runs : M.RunsFor(Group.Order.GetData());
		TArray<uint32> Indices;
		for (const ugo9core::GpuTables::Run &R : Runs)
		{
			if (R.indices.empty()) continue;
			Set.Runs.Add({ R.blend, (uint32)Indices.Num(), (uint32)R.indices.size() });
			Indices.Append(R.indices.data(), (int32)R.indices.size());
		}
		UgoKeep(GraphBuilder, Set.Indices, TEXT("Ugo9.Indices"), Indices.GetData(), Indices.Num(), sizeof(uint32));
		return Set;
	}

	// models not drawn for a while give their buffers back
	void ForgetUnused()
	{
		for (auto It = Gpu.CreateIterator(); It; ++It)
			if (Frame - It.Value().LastUsed > 300) It.RemoveCurrent();
	}

	TWeakObjectPtr<UUgoWorldSubsystem> Owner;
	TArray<FUgoBatch> RenderBatches;               // render thread
	TMap<const ugo9core::Model *, FUgoModelGpu> Gpu; // render thread
	uint64 Frame = 0;                              // render thread
	int32 LastDraws = 0, LastModels = 0;           // render thread (read without a lock for the statistics only)
};

void UUgoWorldSubsystem::Initialize(FSubsystemCollectionBase &Collection)
{
	Super::Initialize(Collection);
	Extension = FSceneViewExtensions::NewExtension<FUgoViewExtension>(GetWorld(), this);
}

void UUgoWorldSubsystem::Deinitialize()
{
	Extension.Reset();
	Super::Deinitialize();
}
