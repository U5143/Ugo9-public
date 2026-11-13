/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "UgoModelAsset.h"

#include "Engine/Texture2D.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogUgo9, Log, All);

static TArray<FString> ToStrings(const std::vector<std::string> &names)
{
	TArray<FString> out;
	out.Reserve((int32)names.size());
	for (const std::string &n : names) out.Add(UTF8_TO_TCHAR(n.c_str()));
	return out;
}

bool UUgoModelAsset::SetData(const TArray<uint8> &Bytes, FString &OutError)
{
	auto fresh = MakeShared<ugo9core::Model>();
	if (!fresh->Load(Bytes.GetData(), (size_t)Bytes.Num()))
	{
		OutError = UTF8_TO_TCHAR(fresh->Error().c_str());
		return false;
	}
	if (fresh->Warnings() != 0) UE_LOG(LogUgo9, Warning, TEXT("%s"), UTF8_TO_TCHAR(fresh->WarningText().c_str()));
	Data = Bytes;
	Model = fresh;
	bTried = true;
	return true;
}

const ugo9core::Model *UUgoModelAsset::Core() const
{
	if (!bTried)
	{
		bTried = true;
		auto fresh = MakeShared<ugo9core::Model>();
		if (Data.Num() > 0 && fresh->Load(Data.GetData(), (size_t)Data.Num()))
		{
			if (fresh->Warnings() != 0) UE_LOG(LogUgo9, Warning, TEXT("%s: %s"), *GetName(), UTF8_TO_TCHAR(fresh->WarningText().c_str()));
			Model = fresh;
		}
		else if (Data.Num() > 0)
		{
			UE_LOG(LogUgo9, Error, TEXT("%s: %s"), *GetName(), UTF8_TO_TCHAR(fresh->Error().c_str()));
		}
	}
	return Model.IsValid() ? Model.Get() : nullptr;
}

void UUgoModelAsset::PostLoad()
{
	Super::PostLoad();
	bTried = false; // loaded from the bytes on first use
}

TArray<FString> UUgoModelAsset::GetParameterNames() const { return Core() ? ToStrings(Core()->ParameterNames()) : TArray<FString>(); }
TArray<FString> UUgoModelAsset::GetAnimationNames() const { return Core() ? ToStrings(Core()->AnimationNames()) : TArray<FString>(); }
TArray<FString> UUgoModelAsset::GetPartNames() const { return Core() ? ToStrings(Core()->PartNames()) : TArray<FString>(); }
TArray<FString> UUgoModelAsset::GetExpressionNames() const { return Core() ? ToStrings(Core()->ExpressionNames()) : TArray<FString>(); }
TArray<FString> UUgoModelAsset::GetTextureNames() const { return Core() ? ToStrings(Core()->TextureNames()) : TArray<FString>(); }

void UUgoModelAsset::GetParameterRange(const FString &Name, float &Min, float &Max, float &Default) const
{
	const ugo9core::Model *m = Core();
	const int i = m ? m->FindParameter(TCHAR_TO_UTF8(*Name)) : -1;
	Min = m ? m->ParameterMin(i) : 0.0f;
	Max = m ? m->ParameterMax(i) : 0.0f;
	Default = m ? m->ParameterDefault(i) : 0.0f;
}

void UUgoModelAsset::GetAnimationInfo(const FString &Name, float &Duration, bool &bLoops) const
{
	const ugo9core::Model *m = Core();
	const int i = m ? m->FindAnimation(TCHAR_TO_UTF8(*Name)) : -1;
	Duration = m ? m->AnimationDuration(i) : 0.0f;
	bLoops = m ? m->AnimationLoops(i) : false;
}

UTexture2D *UUgoModelAsset::GetAtlasTexture(int32 Index)
{
	if (!Atlases.IsValidIndex(Index)) return nullptr;
	if (AtlasTextures.Num() < Atlases.Num()) AtlasTextures.SetNum(Atlases.Num());
	if (AtlasTextures[Index] || Atlases[Index].Bytes.Num() == 0) return AtlasTextures[Index];
	IImageWrapperModule &Images = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
	TSharedPtr<IImageWrapper> Png = Images.CreateImageWrapper(EImageFormat::PNG);
	TArray<uint8> Raw;
	if (!Png.IsValid() || !Png->SetCompressed(Atlases[Index].Bytes.GetData(), Atlases[Index].Bytes.Num()) || !Png->GetRaw(ERGBFormat::BGRA, 8, Raw))
	{
		UE_LOG(LogUgo9, Error, TEXT("%s: the atlas %s is not a readable PNG"), *GetName(), *Atlases[Index].Name);
		return nullptr;
	}
	// premultiplied, as every Ugo9 runtime draws (no bright edges where transparent texels meet)
	for (int32 i = 0; i + 3 < Raw.Num(); i += 4)
	{
		const uint32 a = Raw[i + 3];
		for (int32 k = 0; k < 3; k++) Raw[i + k] = (uint8)((Raw[i + k] * a + 127) / 255);
	}
	const int32 W = (int32)Png->GetWidth(), H = (int32)Png->GetHeight();
	UTexture2D *T = UTexture2D::CreateTransient(W, H, PF_B8G8R8A8, FName(*FString::Printf(TEXT("%s_Atlas%d"), *GetName(), Index)));
	if (!T) return nullptr;
	void *Mip = T->GetPlatformData()->Mips[0].BulkData.Lock(LOCK_READ_WRITE);
	FMemory::Memcpy(Mip, Raw.GetData(), Raw.Num());
	T->GetPlatformData()->Mips[0].BulkData.Unlock();
	T->SRGB = true;
	T->Filter = TF_Bilinear;
	T->AddressX = TA_Clamp;
	T->AddressY = TA_Clamp;
	T->UpdateResource();
	AtlasTextures[Index] = T;
	return T;
}
