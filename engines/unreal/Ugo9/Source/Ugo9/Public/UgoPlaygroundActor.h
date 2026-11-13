/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// The playground: put this actor in any level, choose its Model (e.g. the sample "model" from
// Resources/Samples/basic), press Play. Like the other engines' playgrounds (Unity's
// UgoPlayground, Godot's demo/playground.tscn, web/engines/): pick animations, expressions,
// blinking on its own, the mouth while Space is held, the face following the mouse, and the
// name of the part clicked, shown on the screen. A camera looks at the character's front.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"

#include "UgoPlaygroundActor.generated.h"

class UCameraComponent;
class UUgoCharacterComponent;
class UUgoModelAsset;

UCLASS(ClassGroup = (Ugo9))
class UGO9_API AUgoPlaygroundActor : public AActor
{
	GENERATED_BODY()

public:
	AUgoPlaygroundActor();

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Ugo9")
	TObjectPtr<UUgoCharacterComponent> Character;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Ugo9")
	TObjectPtr<UCameraComponent> Camera;

	// Use this actor's camera when the game starts.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9")
	bool bUseCamera = true;

	virtual void OnConstruction(const FTransform &Transform) override;
	virtual void BeginPlay() override;
	virtual void Tick(float DeltaTime) override;

private:
	void Show(const FString &Line, int32 Key, const FColor &Color = FColor::White) const;
	int32 AnimIndex = 0, ExprIndex = -1;
	FString Picked;
};
