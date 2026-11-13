/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// The Ugo9 characters of a world, and the scene view extension that draws them: once a frame
// their frame blocks go to the render thread, where each model's characters draw with one
// instanced call per run of parts (UgoRendering.cpp).
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"

#include "UgoWorldSubsystem.generated.h"

class UUgoCharacterComponent;
class FUgoViewExtension;

UCLASS()
class UGO9_API UUgoWorldSubsystem : public UWorldSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase &Collection) override;
	virtual void Deinitialize() override;

	void Add(UUgoCharacterComponent *C) { Characters.AddUnique(C); }
	void Remove(UUgoCharacterComponent *C) { Characters.Remove(C); }
	const TArray<TWeakObjectPtr<UUgoCharacterComponent>> &GetCharacters() const { return Characters; }

	// Characters drawn, draw calls (one per run of parts sharing a blend class, per draw order)
	// and models drawn in the last frame.
	UFUNCTION(BlueprintPure, Category = "Ugo9")
	int32 GetCharacterCount() const { return LastCharacters; }
	UFUNCTION(BlueprintPure, Category = "Ugo9")
	int32 GetDrawCount() const { return LastDraws; }
	UFUNCTION(BlueprintPure, Category = "Ugo9")
	int32 GetModelCount() const { return LastModels; }

	int32 LastCharacters = 0, LastDraws = 0, LastModels = 0;

private:
	TArray<TWeakObjectPtr<UUgoCharacterComponent>> Characters;
	TSharedPtr<FUgoViewExtension, ESPMode::ThreadSafe> Extension;
};
