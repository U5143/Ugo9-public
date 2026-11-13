/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "UgoCharacterComponent.h"

#include "Components/AudioComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UgoModelAsset.h"
#include "UgoWorldSubsystem.h"

DEFINE_LOG_CATEGORY_STATIC(LogUgo9, Log, All);

static std::string Utf8(const FString &S) { return std::string(TCHAR_TO_UTF8(*S)); }
static FString FromUtf8(const std::string &S) { return FString(UTF8_TO_TCHAR(S.c_str())); }
static std::vector<std::string> Utf8List(const TArray<FString> &L)
{
	std::vector<std::string> Out;
	for (const FString &S : L) Out.push_back(Utf8(S));
	return Out;
}

UUgoCharacterComponent::UUgoCharacterComponent()
{
	PrimaryComponentTick.bCanEverTick = true;
	PrimaryComponentTick.TickGroup = TG_PostUpdateWork; // after the game moved it and set its parameters
	bTickInEditor = true;                               // animations play in the editor's viewports too
}

bool UUgoCharacterComponent::Ready()
{
	TSharedPtr<const ugo9core::Model> M = Model ? Model->CoreShared() : nullptr;
	if (!M.IsValid())
	{
		Instance.Reset();
		BuiltFor.Reset();
		Frame.Reset();
		Layers.Bind(nullptr);
		Expressions.Bind(nullptr);
		return false;
	}
	if (M != BuiltFor)
	{
		Instance = MakeUnique<ugo9core::Instance>(*M);
		if (BuiltFor.IsValid()) Overrides.Reset(); // parameter numbers belong to a model
		BuiltFor = M;
		Layers.Bind(M.Get());
		Expressions.Bind(M.Get());
		Layers.Finished = [this](int L, const std::string &N) { OnLayerFinished.Broadcast(L + 1, FromUtf8(N)); };
		FadeFromAnim = -1;
		ExpressionShown.Reset();
	}
	if (ExpressionShown != Expression)
	{
		if (!ExpressionShown.IsEmpty()) Expressions.Hide(Utf8(ExpressionShown), 0);
		if (!Expression.IsEmpty()) Expressions.Show(Utf8(Expression), 0);
		ExpressionShown = Expression;
	}
	return Instance->IsValid();
}

float UUgoCharacterComponent::Upp() const { return FMath::Max(1e-6f, Model ? Model->UnitsPerPixel : 1.0f); }

// ---- the main animation ----

void UUgoCharacterComponent::Play(const FString &Name, float FromTime, float Fade)
{
	const int Current = Ready() ? BuiltFor->FindAnimation(Utf8(Animation)) : -1;
	if (Fade > 0 && Current >= 0) { FadeFromAnim = Current; FadeFromTime = Time; FadeTotal = Fade; FadeT = 0; }
	else FadeFromAnim = -1;
	Animation = Name;
	Time = FromTime;
	bPlaying = true;
	bFinished = false;
	Queue.Reset();
}

void UUgoCharacterComponent::PlayNext(const FString &Name, float Fade) { Queue.Emplace(Name, Fade); }

void UUgoCharacterComponent::Advance(float DeltaTime)
{
	if (!bPlaying || !Ready()) return;
	const float Dt = DeltaTime * Speed;
	Time += Dt;
	Layers.Update(Dt);
	if (FadeFromAnim >= 0)
	{
		FadeFromTime += Dt;
		FadeT += DeltaTime;
		if (FadeT >= FadeTotal) FadeFromAnim = -1;
	}
	if (FinishedFor != Animation) { bFinished = false; FinishedFor = Animation; }
	const int Anim = BuiltFor->FindAnimation(Utf8(Animation));
	const float D = Anim >= 0 ? BuiltFor->AnimationDuration(Anim) : 0.0f;
	if (Anim >= 0 && D > 0 && !BuiltFor->AnimationLoops(Anim) && Time >= D && !bFinished)
	{
		bFinished = true;
		const FString Ended = Animation;
		OnAnimationFinished.Broadcast(Ended);
		if (Queue.Num() > 0 && Animation == Ended) // (a handler may have started something else)
		{
			const TPair<FString, float> Next = Queue[0];
			Queue.RemoveAt(0);
			TArray<TPair<FString, float>> Rest = Queue;
			Play(Next.Key, 0.0f, Next.Value);
			FinishedFor = Animation;
			Queue = Rest;
		}
	}
	// keep the clock small: looping and clamped animations look the same
	if (D > 0 && Time > 2 * D) Time = D + FMath::Fmod(Time - D, D);
}

// ---- parameters ----

void UUgoCharacterComponent::SetParam(const FString &Name, float Value)
{
	const int i = Ready() ? BuiltFor->FindParameter(Utf8(Name)) : -1;
	if (i >= 0) Overrides.Add(i, Value);
}

void UUgoCharacterComponent::ClearParam(const FString &Name)
{
	const int i = Ready() ? BuiltFor->FindParameter(Utf8(Name)) : -1;
	Overrides.Remove(i);
}

void UUgoCharacterComponent::ClearParams() { Overrides.Reset(); }

float UUgoCharacterComponent::GetParam(const FString &Name) const
{
	if (!Instance || !BuiltFor) return 0.0f;
	return Instance->GetParam(BuiltFor->FindParameter(Utf8(Name)));
}

// ---- layers ----

bool UUgoCharacterComponent::StartLayer(bool bQueue, int32 Layer, const FString &Name, float Fade, bool bAdditive, const TArray<FString> &MaskBones,
                                        const TArray<FString> &MaskParts, const TArray<FString> &MaskParameters, float Weight, EUgoLoop Loop, float LayerSpeed)
{
	if (Layer < 1)
	{
		UE_LOG(LogUgo9, Warning, TEXT("Ugo9: layers start at 1 (layer 0 is the main animation: Play)"));
		return false;
	}
	if (!Ready()) return false;
	std::shared_ptr<ugo9core::AnimMask> Mask;
	if (MaskBones.Num() || MaskParts.Num() || MaskParameters.Num())
	{
		Mask = std::make_shared<ugo9core::AnimMask>();
		std::string Error;
		if (!Mask->Make(*BuiltFor, Utf8List(MaskBones), Utf8List(MaskParts), Utf8List(MaskParameters), Error))
		{
			UE_LOG(LogUgo9, Warning, TEXT("%s"), *FromUtf8(Error));
			return false;
		}
	}
	const int L = Loop == EUgoLoop::Loop ? 1 : Loop == EUgoLoop::Once ? 0 : -1;
	return bQueue ? Layers.Queue(Layer - 1, Utf8(Name), Fade, L, LayerSpeed, Weight, bAdditive, Mask)
	              : Layers.Play(Layer - 1, Utf8(Name), Fade, L, LayerSpeed, Weight, bAdditive, Mask);
}

bool UUgoCharacterComponent::PlayLayer(int32 Layer, const FString &Name, float Fade, bool bAdditive, const TArray<FString> &MaskBones, const TArray<FString> &MaskParts,
                                       const TArray<FString> &MaskParameters, float Weight, EUgoLoop Loop, float LayerSpeed)
{
	return StartLayer(false, Layer, Name, Fade, bAdditive, MaskBones, MaskParts, MaskParameters, Weight, Loop, LayerSpeed);
}

bool UUgoCharacterComponent::QueueLayer(int32 Layer, const FString &Name, float Fade, bool bAdditive, const TArray<FString> &MaskBones, const TArray<FString> &MaskParts,
                                        const TArray<FString> &MaskParameters, float Weight, EUgoLoop Loop, float LayerSpeed)
{
	return StartLayer(true, Layer, Name, Fade, bAdditive, MaskBones, MaskParts, MaskParameters, Weight, Loop, LayerSpeed);
}

void UUgoCharacterComponent::StopLayer(int32 Layer, float Fade) { Layers.Stop(Layer - 1, Fade); }
void UUgoCharacterComponent::SetLayerWeight(int32 Layer, float Weight) { if (Layer >= 1) Layers.SetWeight(Layer - 1, Weight); }
float UUgoCharacterComponent::GetLayerWeight(int32 Layer) const { return Layers.GetWeight(Layer - 1); }
FString UUgoCharacterComponent::GetLayerAnimation(int32 Layer) const
{
	const ugo9core::Layers::Entry *E = Layers.Current(Layer - 1);
	return E ? FromUtf8(E->name) : FString();
}

// ---- expressions ----

TArray<FString> UUgoCharacterComponent::GetExpressionNames() const
{
	TArray<FString> Out;
	if (Model && Model->CoreShared().IsValid())
		for (const std::string &N : Model->CoreShared()->ExpressionNames()) Out.Add(FromUtf8(N));
	return Out;
}

void UUgoCharacterComponent::ShowExpression(const FString &Name, float Fade) { if (Ready()) Expressions.Show(Utf8(Name), Fade); }
void UUgoCharacterComponent::HideExpression(const FString &Name, float Fade) { if (Ready()) Expressions.Hide(Utf8(Name), Fade); }
void UUgoCharacterComponent::OnlyExpressions(const TArray<FString> &Names) { if (Ready()) Expressions.Only(Utf8List(Names)); }
float UUgoCharacterComponent::GetExpressionWeight(const FString &Name) const { return Expressions.Weight(Utf8(Name)); }

bool UUgoCharacterComponent::LoadExpressions(const FString &Json, TArray<FString> &MissingParameters)
{
	MissingParameters.Reset();
	if (!Ready()) return false;
	TSharedPtr<FJsonObject> Root;
	FString Format;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Root) || !Root.IsValid() || !Root->TryGetStringField(TEXT("format"), Format)
	    || Format != TEXT("ugo9-expressions"))
	{
		UE_LOG(LogUgo9, Warning, TEXT("Ugo9: not an expression preset (format \"ugo9-expressions\")"));
		return false;
	}
	std::vector<ugo9core::Expressions::Preset> Presets;
	const TArray<TSharedPtr<FJsonValue>> *Items = nullptr;
	if (Root->TryGetArrayField(TEXT("expressions"), Items))
	{
		for (const TSharedPtr<FJsonValue> &Item : *Items)
		{
			const TSharedPtr<FJsonObject> *E = nullptr;
			FString Id;
			if (!Item.IsValid() || !Item->TryGetObject(E) || !(*E)->TryGetStringField(TEXT("id"), Id)) continue;
			ugo9core::Expressions::Preset P;
			P.id = Utf8(Id);
			double V = 0;
			if ((*E)->TryGetNumberField(TEXT("fadeIn"), V)) P.fadeIn = (float)V;
			if ((*E)->TryGetNumberField(TEXT("fadeOut"), V)) P.fadeOut = (float)V;
			const TSharedPtr<FJsonObject> *Params = nullptr;
			if ((*E)->TryGetObjectField(TEXT("params"), Params))
			{
				for (const TPair<FString, TSharedPtr<FJsonValue>> &KV : (*Params)->Values)
				{
					const TArray<TSharedPtr<FJsonValue>> *Pair = nullptr;
					double Value = 0;
					FString Op;
					if (!KV.Value.IsValid() || !KV.Value->TryGetArray(Pair) || Pair->Num() < 2 || !(*Pair)[1]->TryGetNumber(Value)) continue;
					(*Pair)[0]->TryGetString(Op);
					const uint32 Code = Op == TEXT("set") ? 0u : Op == TEXT("add") ? 1u : Op == TEXT("multiply") ? 2u : 0xffffffffu; // unknown: skipped by the core
					P.names.push_back(Utf8(KV.Key));
					P.ops.push_back(Code);
					P.values.push_back((float)Value);
				}
			}
			Presets.push_back(MoveTemp(P));
		}
	}
	for (const std::string &N : Expressions.Load(MoveTemp(Presets))) MissingParameters.Add(FromUtf8(N));
	return true;
}

// ---- helpers ----

void UUgoCharacterComponent::LookAt(FVector WorldPoint) { LookPoint = WorldPoint; }
void UUgoCharacterComponent::StopLooking() { LookPoint.Reset(); LookTarget = nullptr; }
void UUgoCharacterComponent::SetMouthLevel(float Level) { bVoice = false; LipSyncSource = nullptr; BindLipSync(); Helpers.mouthLevel = Level; }

void UUgoCharacterComponent::BindLipSync()
{
	UAudioComponent *Want = LipSyncSource.Get();
	if (BoundSource.Get() == Want && (Want == nullptr || EnvelopeHandle.IsValid())) return;
	if (UAudioComponent *Old = BoundSource.Get()) Old->OnAudioSingleEnvelopeValueNative.Remove(EnvelopeHandle);
	EnvelopeHandle.Reset();
	BoundSource = Want;
	Envelope = 0.0f;
	EnvelopeAt = -1.0;
	if (Want) EnvelopeHandle = Want->OnAudioSingleEnvelopeValueNative.AddUObject(this, &UUgoCharacterComponent::OnEnvelope);
	else if (bVoice) { bVoice = false; Helpers.mouthLevel = -1.0f; } // back to the animation
}

void UUgoCharacterComponent::OnEnvelope(const UAudioComponent *, const USoundWave *, const float Value)
{
	Envelope = Value;
	EnvelopeAt = FPlatformTime::Seconds();
}
void UUgoCharacterComponent::SetVoiceLoudness(float Db) { bVoice = true; VoiceDb = Db; }

// ---- model pixels and the world ----

FVector2D UUgoCharacterComponent::WorldToModel(FVector WorldPoint) const
{
	const FVector L = GetComponentTransform().InverseTransformPosition(WorldPoint);
	return FVector2D(L.X / Upp(), -L.Z / Upp());
}

FVector UUgoCharacterComponent::ModelToWorld(FVector2D P) const
{
	return GetComponentTransform().TransformPosition(FVector(P.X * Upp(), 0.0, -P.Y * Upp()));
}

bool UUgoCharacterComponent::RayToPlane(FVector Origin, FVector Direction, FVector &WorldPoint) const
{
	const FVector N = GetComponentTransform().GetUnitAxis(EAxis::Y), P = GetComponentLocation();
	const double D = FVector::DotProduct(Direction, N);
	if (FMath::Abs(D) < 1e-9) return false;
	const double T = FVector::DotProduct(P - Origin, N) / D;
	if (T < 0) return false;
	WorldPoint = Origin + Direction * T;
	return true;
}

// ---- picking ----

FString UUgoCharacterComponent::PartAt(FVector WorldPoint, float MinOpacity) const
{
	if (!Instance || !BuiltFor) return FString();
	const FVector2D P = WorldToModel(WorldPoint);
	const int Part = Instance->PickPart((float)P.X, (float)P.Y, MinOpacity);
	return Part >= 0 ? FromUtf8(BuiltFor->PartNames()[Part]) : FString();
}

FString UUgoCharacterComponent::AreaAt(FVector WorldPoint) const
{
	if (!Instance || !BuiltFor) return FString();
	const FVector2D P = WorldToModel(WorldPoint);
	return FromUtf8(BuiltFor->AreaOfPart(Instance->PickArea((float)P.X, (float)P.Y)));
}

TArray<FString> UUgoCharacterComponent::GetAreaNames() const
{
	TArray<FString> Out;
	if (Model && Model->CoreShared().IsValid())
		for (const std::string &N : Model->CoreShared()->AreaNames()) Out.Add(FromUtf8(N));
	return Out;
}

bool UUgoCharacterComponent::PartBounds(const FString &Part, FBox &Box) const
{
	if (!Instance || !BuiltFor) return false;
	const int i = Part.IsEmpty() ? -1 : BuiltFor->FindPart(Utf8(Part));
	if (!Part.IsEmpty() && i < 0) return false;
	float B[4];
	if (!Instance->Bounds(i, B)) return false;
	Box = FBox(ForceInit);
	for (int k = 0; k < 4; k++) Box += ModelToWorld(FVector2D(B[(k & 1) ? 2 : 0], B[(k & 2) ? 3 : 1]));
	return true;
}

// ---- bones ----

bool UUgoCharacterComponent::GetBoneTransform(const FString &Bone, FVector &Location, FRotator &Rotation) const
{
	if (!Instance || !BuiltFor) return false;
	float W[6];
	if (!Instance->BoneWorld(BuiltFor->FindBone(Utf8(Bone)), W)) return false;
	const FTransform &T = GetComponentTransform();
	Location = ModelToWorld(FVector2D(W[4], W[5]));
	// the bone's x axis in model pixels (y down) on the plane, then in the world
	const FVector Along = T.TransformVectorNoScale(FVector(W[0], 0.0, -W[1]).GetSafeNormal());
	Rotation = FRotationMatrix::MakeFromXY(Along, T.GetUnitAxis(EAxis::Y)).Rotator();
	return true;
}

void UUgoCharacterComponent::ReachFor(const FString &Bone, FVector WorldPoint, int32 Chain)
{
	const int B = Ready() ? BuiltFor->FindBone(Utf8(Bone)) : -1;
	if (B >= 0) Reach.Add({ B, FMath::Max(1, Chain), WorldToModel(WorldPoint) });
}

// ---- each frame ----

void UUgoCharacterComponent::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction *ThisTickFunction)
{
	Super::TickComponent(DeltaTime, TickType, ThisTickFunction);
	const UWorld *W = GetWorld();
	const bool bGame = W && W->IsGameWorld();
	if (bGame || bPreviewInEditor) Advance(DeltaTime);
	UpdateNow(DeltaTime);
}

void UUgoCharacterComponent::UpdateNow(float DeltaTime)
{
	if (!Ready()) return;
	const ugo9core::Model &M = *BuiltFor;
	ugo9core::Instance &In = *Instance;
	In.ResetParams();
	const int Anim = M.FindAnimation(Utf8(Animation));
	if (FadeFromAnim >= 0 && FadeTotal > 0)
	{
		// a cross-fade: the one before at full weight, the new one over it
		In.ApplyAnimation(FadeFromAnim, FadeFromTime, 1.0f);
		if (Anim >= 0) In.ApplyAnimation(Anim, Time, FMath::Min(1.0f, FadeT / FadeTotal));
	}
	else if (Anim >= 0) In.ApplyAnimation(Anim, Time, 1.0f);
	Layers.Apply(In);
	for (const TPair<FString, float> &P : Parameters) In.SetParam(M.FindParameter(Utf8(P.Key)), P.Value);
	for (const TPair<int32, float> &O : Overrides) In.SetParam(O.Key, O.Value);
	// expressions after the animations and SetParam, before the update (physics follows them)
	Expressions.Update(DeltaTime);
	Expressions.Apply(In);

	// helpers: looking, blinking, the mouth
	const AActor *Target = LookTarget.Get();
	const TOptional<FVector> At = Target ? TOptional<FVector>(Target->GetActorLocation()) : LookPoint;
	Helpers.looking = At.IsSet();
	if (At.IsSet())
	{
		float C[4];
		M.Canvas(C);
		const FVector2D Face = !LookFrom.IsZero() ? LookFrom : FVector2D(C[0] / 2 - C[2], C[1] / 4 - C[3]);
		const FVector2D P = WorldToModel(At.GetValue());
		Helpers.lookX = (float)(P.X - Face.X);
		Helpers.lookY = (float)(P.Y - Face.Y);
	}
	Helpers.autoBlink = bAutoBlink;
	BindLipSync();
	if (BoundSource.IsValid())
	{
		// the envelope is a level (0..1): as dB, times the gain; silence when the sound stops sending it
		const double Now = FPlatformTime::Seconds();
		const bool bFresh = BoundSource->IsPlaying() && EnvelopeAt >= 0 && Now - EnvelopeAt < 0.25;
		VoiceDb = bFresh ? FMath::Max(-100.0f, 20.0f * FMath::LogX(10.0f, FMath::Max(1e-6f, Envelope * FMath::Max(1e-6f, LipSyncGain)))) : -100.0f;
		bVoice = true;
	}
	if (bVoice)
	{
		Gate.gateDb = VoiceGateDb;
		Gate.rangeDb = VoiceRangeDb;
		Helpers.mouthLevel = Gate.Update(VoiceDb, DeltaTime);
	}
	Helpers.Apply(M, In, DeltaTime);

	// placement on the X–Z plane, in model pixels (y down): x along the component's X, y along its −Z
	const float U = Upp();
	const FTransform &T = GetComponentTransform();
	const FVector X = T.TransformVector(FVector(1, 0, 0)), Z = T.TransformVector(FVector(0, 0, 1)), P = T.GetLocation();
	In.SetTransform((float)X.X, (float)-X.Z, (float)-Z.X, (float)Z.Z, (float)(P.X / U), (float)(-P.Z / U));
	In.SetWind((float)Wind.X, (float)-Wind.Y, WindGust);
	In.Update(DeltaTime);
	// reaching: from the pose just made, then once more to show it (and let constraints follow)
	if (Reach.Num() > 0)
	{
		for (const FReach &R : Reach) In.SolveIK(R.Bone, R.Chain, (float)R.Target.X, (float)R.Target.Y);
		Reach.Reset();
		In.Update(0.0f);
	}
	Depth = (float)P.Y;
	DrawOrderKey = M.HasDrawOrder() ? In.DrawOrderKey() : 0;
	if (DrawOrderKey != 0) DrawOrder = TArray<uint32>(In.DrawOrder(), (int32)M.PartNames().size());
	else DrawOrder.Reset();

	// the frame block, with the whole character's colour in its header's floats 6 and 7 (white, opaque: 0, 0)
	const uint32 FF = M.FrameFloats();
	Frame.SetNumUninitialized(FF);
	FMemory::Memcpy(Frame.GetData(), In.Frame(), FF * sizeof(float));
	auto Dark = [](float V) { return FMath::RoundToInt((1.0f - FMath::Clamp(V, 0.0f, 1.0f)) * 255.0f); };
	Frame[6] = (float)(Dark(Color.R) * 65536 + Dark(Color.G) * 256 + Dark(Color.B));
	Frame[7] = 1.0f - FMath::Clamp(Color.A, 0.0f, 1.0f);
}

void UUgoCharacterComponent::OnRegister()
{
	Super::OnRegister();
	if (UWorld *W = GetWorld())
	{
		if (UUgoWorldSubsystem *S = W->GetSubsystem<UUgoWorldSubsystem>()) S->Add(this);
	}
}

void UUgoCharacterComponent::OnUnregister()
{
	if (UAudioComponent *Old = BoundSource.Get()) Old->OnAudioSingleEnvelopeValueNative.Remove(EnvelopeHandle);
	BoundSource.Reset();
	EnvelopeHandle.Reset();
	if (UWorld *W = GetWorld())
	{
		if (UUgoWorldSubsystem *S = W->GetSubsystem<UUgoWorldSubsystem>()) S->Remove(this);
	}
	Super::OnUnregister();
}
