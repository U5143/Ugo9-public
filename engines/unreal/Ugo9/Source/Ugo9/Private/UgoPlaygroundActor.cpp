/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "UgoPlaygroundActor.h"

#include "Camera/CameraComponent.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "InputCoreTypes.h"
#include "UgoCharacterComponent.h"
#include "UgoModelAsset.h"

AUgoPlaygroundActor::AUgoPlaygroundActor()
{
	PrimaryActorTick.bCanEverTick = true;
	Character = CreateDefaultSubobject<UUgoCharacterComponent>(TEXT("Character"));
	RootComponent = Character;
	Character->bAutoBlink = true;
	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(Character);
	// the character faces −Y: the camera stands in front of it, looking along +Y
	Camera->SetRelativeLocation(FVector(0.0, -900.0, -300.0));
	Camera->SetRelativeRotation(FRotator(0.0, 90.0, 0.0));
}

void AUgoPlaygroundActor::OnConstruction(const FTransform &Transform)
{
	Super::OnConstruction(Transform);
	// frame the model's canvas: its middle, far enough to see it all at the camera's field of view
	const UUgoModelAsset *M = Character ? Character->Model.Get() : nullptr;
	if (!M || !M->CoreShared().IsValid() || !Camera) return;
	float C[4];
	M->CoreShared()->Canvas(C);
	const double Upp = FMath::Max(1e-6f, M->UnitsPerPixel);
	const double MidX = (C[0] / 2 - C[2]) * Upp, MidZ = -(C[1] / 2 - C[3]) * Upp, H = FMath::Max(C[0], C[1]) * Upp;
	const double Dist = H * 0.6 / FMath::Tan(FMath::DegreesToRadians(Camera->FieldOfView * 0.5)) + 10.0;
	Camera->SetRelativeLocation(FVector(MidX, -Dist, MidZ));
}

void AUgoPlaygroundActor::BeginPlay()
{
	Super::BeginPlay();
	if (APlayerController *PC = GetWorld() ? GetWorld()->GetFirstPlayerController() : nullptr)
	{
		PC->bShowMouseCursor = true;
		PC->bEnableClickEvents = true;
		if (bUseCamera) PC->SetViewTarget(this);
	}
	if (Character && Character->Model && Character->Model->CoreShared().IsValid() && !Character->Model->CoreShared()->AnimationNames().empty() && Character->Animation.IsEmpty())
		Character->Play(UTF8_TO_TCHAR(Character->Model->CoreShared()->AnimationNames()[0].c_str()));
}

void AUgoPlaygroundActor::Show(const FString &Line, int32 Key, const FColor &Color) const
{
	if (GEngine) GEngine->AddOnScreenDebugMessage((uint64)GetUniqueID() * 16 + Key, 0.0f, Color, Line);
}

void AUgoPlaygroundActor::Tick(float DeltaTime)
{
	Super::Tick(DeltaTime);
	if (!Character || !Character->Model || !Character->Model->CoreShared().IsValid())
	{
		Show(TEXT("Ugo9 playground: choose the Model (Details → Character → Model)"), 0, FColor::Yellow);
		return;
	}
	const ugo9core::Model &M = *Character->Model->CoreShared();
	APlayerController *PC = GetWorld() ? GetWorld()->GetFirstPlayerController() : nullptr;
	if (!PC) return;
	auto Pressed = [PC](const FKey &K) { return PC->WasInputKeyJustPressed(K); };

	// N / P: the next or previous animation (blended over 0.3 s); 0: none
	const int32 NA = (int32)M.AnimationNames().size();
	if (NA > 0 && (Pressed(EKeys::N) || Pressed(EKeys::P)))
	{
		AnimIndex = (AnimIndex + (Pressed(EKeys::N) ? 1 : NA - 1)) % NA;
		Character->Play(UTF8_TO_TCHAR(M.AnimationNames()[AnimIndex].c_str()), 0.0f, 0.3f);
	}
	if (Pressed(EKeys::Zero)) Character->Play(FString(), 0.0f, 0.3f);
	// E: the next expression (the model's own), then none
	const int32 NE = (int32)M.ExpressionNames().size();
	if (Pressed(EKeys::E))
	{
		ExprIndex = NE > 0 ? (ExprIndex + 2) % (NE + 1) - 1 : -1;
		Character->OnlyExpressions(ExprIndex >= 0 ? TArray<FString>{ FString(UTF8_TO_TCHAR(M.ExpressionNames()[ExprIndex].c_str())) } : TArray<FString>());
	}
	// B: blinking on its own; Space: the mouth open while held
	if (Pressed(EKeys::B)) Character->bAutoBlink = !Character->bAutoBlink;
	if (!Character->LipSyncSource) Character->GetHelpers().mouthLevel = PC->IsInputKeyDown(EKeys::SpaceBar) ? 0.9f : 0.0f;

	// the mouse: the face follows it on the character's plane; a click names the part under it
	FVector Origin, Dir, OnPlane;
	if (PC->DeprojectMousePositionToWorld(Origin, Dir) && Character->RayToPlane(Origin, Dir, OnPlane))
	{
		Character->LookAt(OnPlane);
		if (Pressed(EKeys::LeftMouseButton))
		{
			Picked = Character->PartAt(OnPlane);
			const FString Area = Character->AreaAt(OnPlane);
			if (Picked.IsEmpty()) Picked = TEXT("(nothing there)");
			if (!Area.IsEmpty()) Picked += FString::Printf(TEXT("  area: %s"), *Area);
		}
	}
	else Character->StopLooking();

	const FString Anim = Character->Animation.IsEmpty() ? TEXT("(none)") : Character->Animation;
	const FString Expr = ExprIndex >= 0 && ExprIndex < NE ? FString(UTF8_TO_TCHAR(M.ExpressionNames()[ExprIndex].c_str())) : TEXT("(none)");
	Show(TEXT("N / P: animation   0: none   E: expression   B: blinking   Space: mouth   click: part   (mouse: the face follows)"), 1, FColor::Silver);
	Show(FString::Printf(TEXT("animation: %s   expression: %s   blinking: %s"), *Anim, *Expr, Character->bAutoBlink ? TEXT("on") : TEXT("off")), 2);
	Show(FString::Printf(TEXT("clicked: %s"), Picked.IsEmpty() ? TEXT("-") : *Picked), 3, FColor::Cyan);
}
