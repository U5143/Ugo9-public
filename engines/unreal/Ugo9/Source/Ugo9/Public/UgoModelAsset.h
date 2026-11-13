/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// A .ug9 model as an asset: the file's bytes and the atlas images it names (PNG files next to it at
// import, kept as their bytes; textures are made from them when drawing, premultiplied). Many
// characters share one. Its names and ranges are readable from Blueprints.
#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "UgoCore.h"

#include "UgoModelAsset.generated.h"

class UTexture2D;

USTRUCT()
struct FUgoAtlasFile
{
	GENERATED_BODY()

	// the texture's name in the model (e.g. "atlas.png")
	UPROPERTY(VisibleAnywhere, Category = "Ugo9")
	FString Name;

	UPROPERTY()
	TArray<uint8> Bytes;
};

UCLASS(BlueprintType)
class UGO9_API UUgoModelAsset : public UObject
{
	GENERATED_BODY()

public:
	// The .ug9 file's bytes (as compiled by the Ugo9 editor; not read by anything but the core).
	UPROPERTY()
	TArray<uint8> Data;

	// The atlas images the model names, in its order.
	UPROPERTY(VisibleAnywhere, Category = "Ugo9")
	TArray<FUgoAtlasFile> Atlases;

	// Unreal units (cm) per model pixel.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9", meta = (ClampMin = "0.0001"))
	float UnitsPerPixel = 1.0f;

	// The file the model was imported from (for reimport).
	UPROPERTY(VisibleAnywhere, Category = "Ugo9")
	FString SourceFile;

	// Sets the .ug9 bytes; false (and why, with what to do) when the core cannot read them.
	bool SetData(const TArray<uint8> &Bytes, FString &OutError);

	// The loaded model (null when the bytes are missing or unreadable), and a shared hold on it (for the render thread).
	const ugo9core::Model *Core() const;
	TSharedPtr<const ugo9core::Model> CoreShared() const { Core(); return Model; }

	// An atlas page as a texture, premultiplied (made on first use from the PNG's bytes; null without one).
	UTexture2D *GetAtlasTexture(int32 Index = 0);
	// the textures are made again from Atlases (after a reimport)
	void ForgetAtlasTextures() { AtlasTextures.Reset(); }

	UFUNCTION(BlueprintPure, Category = "Ugo9")
	bool IsLoaded() const { return Core() != nullptr; }

	UFUNCTION(BlueprintPure, Category = "Ugo9")
	TArray<FString> GetParameterNames() const;

	UFUNCTION(BlueprintPure, Category = "Ugo9")
	TArray<FString> GetAnimationNames() const;

	UFUNCTION(BlueprintPure, Category = "Ugo9")
	TArray<FString> GetPartNames() const;

	UFUNCTION(BlueprintPure, Category = "Ugo9")
	TArray<FString> GetExpressionNames() const;

	UFUNCTION(BlueprintPure, Category = "Ugo9")
	TArray<FString> GetTextureNames() const;

	// A parameter's range and default (0s for an unknown name).
	UFUNCTION(BlueprintPure, Category = "Ugo9")
	void GetParameterRange(const FString &Name, float &Min, float &Max, float &Default) const;

	// An animation's length in seconds and whether it loops (0 / false for an unknown name).
	UFUNCTION(BlueprintPure, Category = "Ugo9")
	void GetAnimationInfo(const FString &Name, float &Duration, bool &bLoops) const;

	virtual void PostLoad() override;

private:
	mutable TSharedPtr<ugo9core::Model> Model;

	UPROPERTY(Transient)
	TArray<TObjectPtr<UTexture2D>> AtlasTextures;
	mutable bool bTried = false;
};
