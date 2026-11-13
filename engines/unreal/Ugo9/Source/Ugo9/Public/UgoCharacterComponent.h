/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// One Ugo9 character. The core runs on the game thread when the component ticks (a few hundred
// bytes of frame block); the GPU deforms every vertex (UgoRendering). The character stands on
// the world's X–Z plane at the component's place (model x along +X, model y down along −Z, one
// model pixel = the model's UnitsPerPixel cm, times the component's scale), facing −Y.
// The same features as the Unity package's UgoCharacter: cross-fades and a queue for the main
// animation, layers above it, expressions, looking / blinking / lip-sync, picking by part and hit
// area, bones in the world and reaching, wind, the whole character's colour.
#pragma once

#include "CoreMinimal.h"
#include "Components/SceneComponent.h"
#include "UgoCore.h"
#include "UgoFeatures.h"

#include "UgoCharacterComponent.generated.h"

class UAudioComponent;
class USoundWave;
class UUgoModelAsset;

UENUM(BlueprintType)
enum class EUgoLoop : uint8
{
	AsAnimation UMETA(DisplayName = "As the animation"),
	Loop,
	Once,
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FUgoAnimationFinished, const FString &, Animation);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FUgoLayerFinished, int32, Layer, const FString &, Animation);

UCLASS(ClassGroup = (Ugo9), meta = (BlueprintSpawnableComponent))
class UGO9_API UUgoCharacterComponent : public USceneComponent
{
	GENERATED_BODY()

public:
	UUgoCharacterComponent();

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9")
	TObjectPtr<UUgoModelAsset> Model;

	// The animation playing (its name; empty: none). Sequencer can key it (a String track).
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Interp, Category = "Ugo9")
	FString Animation;

	// Off: the clock moves only when Time is set (Sequencer, a Blueprint). In the editor, outside Play, see bPreviewInEditor.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Interp, Category = "Ugo9")
	bool bPlaying = true;

	// Play the animation in the editor's viewports while not playing the game.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9")
	bool bPreviewInEditor = true;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9")
	float Speed = 1.0f;

	// Seconds into the animation. Sequencer can key it (with bPlaying off, the sequence drives the animation).
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Interp, Category = "Ugo9")
	float Time = 0.0f;

	// The whole character's colour and transparency (multiplied with every part).
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Interp, Category = "Ugo9")
	FLinearColor Color = FLinearColor::White;

	// Parameter values set in the Details panel (kept, like SetParam; under it).
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9")
	TMap<FString, float> Parameters;

	// An expression shown from the start (the model's, or a loaded preset's).
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Interp, Category = "Ugo9")
	FString Expression;

	// Wind on the swaying chains (hair, cloth): model pixels per second², x right, y up. Not on parameter physics.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Interp, Category = "Ugo9")
	FVector2D Wind = FVector2D::ZeroVector;

	// How much the wind's strength wavers over time (0: steady).
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9")
	float WindGust = 0.0f;

	// Face, eyes and a little of the body turn towards this actor (HeadTurnX/Y, PupilX/Y, BodyTurnX).
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9|Helpers")
	TObjectPtr<AActor> LookTarget;

	// Where the face is, in model pixels from the model's origin (y down); (0, 0): a quarter down the canvas.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9|Helpers")
	FVector2D LookFrom = FVector2D::ZeroVector;

	// Blink on its own (EyeOpenL / EyeOpenR).
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9|Helpers")
	bool bAutoBlink = false;

	// The mouth (MouthOpen) follows this sound's loudness while it plays (its envelope, through the noise gate).
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9|Helpers")
	TObjectPtr<UAudioComponent> LipSyncSource;

	// Loudness is multiplied by this before the gate (2: +6 dB).
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9|Helpers")
	float LipSyncGain = 1.0f;

	// The noise gate for SetVoiceLoudness and LipSyncSource: quieter than this (dB) leaves the mouth shut; fully open this many dB above it.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9|Helpers")
	float VoiceGateDb = -45.0f;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ugo9|Helpers")
	float VoiceRangeDb = 25.0f;

	// A non-looping main animation reached its end.
	UPROPERTY(BlueprintAssignable, Category = "Ugo9")
	FUgoAnimationFinished OnAnimationFinished;

	// A layer's non-looping animation reached its end (layers start at 1).
	UPROPERTY(BlueprintAssignable, Category = "Ugo9")
	FUgoLayerFinished OnLayerFinished;

	// ---- the main animation ----

	// Play an animation from a time (seconds). Fade > 0: the one playing now blends out over that many seconds.
	UFUNCTION(BlueprintCallable, Category = "Ugo9", meta = (AdvancedDisplay = "FromTime,Fade"))
	void Play(const FString &Name, float FromTime = 0.0f, float Fade = 0.0f);

	// Play this when the current (not looping) animation ends, blending over Fade seconds.
	UFUNCTION(BlueprintCallable, Category = "Ugo9")
	void PlayNext(const FString &Name, float Fade = 0.0f);

	UFUNCTION(BlueprintCallable, Category = "Ugo9")
	void Stop() { bPlaying = false; }

	// The current animation, if it does not loop, has reached its end.
	UFUNCTION(BlueprintPure, Category = "Ugo9")
	bool IsFinished() const { return bFinished; }

	// ---- parameters ----

	// Set a parameter (stays until ClearParam; over the animation).
	UFUNCTION(BlueprintCallable, Category = "Ugo9")
	void SetParam(const FString &Name, float Value);

	UFUNCTION(BlueprintCallable, Category = "Ugo9")
	void ClearParam(const FString &Name);

	UFUNCTION(BlueprintCallable, Category = "Ugo9")
	void ClearParams();

	// The parameter's value as of the last update.
	UFUNCTION(BlueprintPure, Category = "Ugo9")
	float GetParam(const FString &Name) const;

	// ---- layers above the main animation (1, 2, ...): mixed or added on top, on all tracks or only some ----

	// Additive: adds its change from the rest pose. Mask*: only these bones / parts / parameters (empty: all). False: no such animation, or a mask names something the model lacks.
	UFUNCTION(BlueprintCallable, Category = "Ugo9|Layers", meta = (AutoCreateRefTerm = "MaskBones,MaskParts,MaskParameters", AdvancedDisplay = "Weight,Loop,LayerSpeed"))
	bool PlayLayer(int32 Layer, const FString &Name, float Fade, bool bAdditive, const TArray<FString> &MaskBones, const TArray<FString> &MaskParts,
	               const TArray<FString> &MaskParameters, float Weight = 1.0f, EUgoLoop Loop = EUgoLoop::AsAnimation, float LayerSpeed = 1.0f);

	// Plays it on the layer after the current one ends (a looping one: at the end of its loop).
	UFUNCTION(BlueprintCallable, Category = "Ugo9|Layers", meta = (AutoCreateRefTerm = "MaskBones,MaskParts,MaskParameters", AdvancedDisplay = "Weight,Loop,LayerSpeed"))
	bool QueueLayer(int32 Layer, const FString &Name, float Fade, bool bAdditive, const TArray<FString> &MaskBones, const TArray<FString> &MaskParts,
	                const TArray<FString> &MaskParameters, float Weight = 1.0f, EUgoLoop Loop = EUgoLoop::AsAnimation, float LayerSpeed = 1.0f);

	UFUNCTION(BlueprintCallable, Category = "Ugo9|Layers")
	void StopLayer(int32 Layer, float Fade = 0.25f);

	UFUNCTION(BlueprintCallable, Category = "Ugo9|Layers")
	void SetLayerWeight(int32 Layer, float Weight);

	UFUNCTION(BlueprintPure, Category = "Ugo9|Layers")
	float GetLayerWeight(int32 Layer) const;

	// The animation playing on the layer (empty: none).
	UFUNCTION(BlueprintPure, Category = "Ugo9|Layers")
	FString GetLayerAnimation(int32 Layer) const;

	// ---- expressions ----

	UFUNCTION(BlueprintPure, Category = "Ugo9|Expressions")
	TArray<FString> GetExpressionNames() const;

	// Fade < 0: its own fade time.
	UFUNCTION(BlueprintCallable, Category = "Ugo9|Expressions")
	void ShowExpression(const FString &Name, float Fade = -1.0f);

	UFUNCTION(BlueprintCallable, Category = "Ugo9|Expressions")
	void HideExpression(const FString &Name, float Fade = -1.0f);

	// Shows only these; the others fade out.
	UFUNCTION(BlueprintCallable, Category = "Ugo9|Expressions")
	void OnlyExpressions(const TArray<FString> &Names);

	UFUNCTION(BlueprintPure, Category = "Ugo9|Expressions")
	float GetExpressionWeight(const FString &Name) const;

	// Loads an expression preset ({"format": "ugo9-expressions", ...}). Returns the parameter names the model lacks; false: not a preset.
	UFUNCTION(BlueprintCallable, Category = "Ugo9|Expressions")
	bool LoadExpressions(const FString &Json, TArray<FString> &MissingParameters);

	// ---- helpers ----

	// Look at this world point until StopLooking (LookTarget, when set, wins).
	UFUNCTION(BlueprintCallable, Category = "Ugo9|Helpers")
	void LookAt(FVector WorldPoint);

	UFUNCTION(BlueprintCallable, Category = "Ugo9|Helpers")
	void StopLooking();

	// The mouth's opening, 0..1 (from your own analysis); negative: back to the animation.
	UFUNCTION(BlueprintCallable, Category = "Ugo9|Helpers")
	void SetMouthLevel(float Level);

	// Lip-sync from loudness: the sound's level now in dB (of the RMS), every frame while it plays; through the noise gate.
	UFUNCTION(BlueprintCallable, Category = "Ugo9|Helpers")
	void SetVoiceLoudness(float Db);

	// ---- picking (clicks, taps), boxes ----

	// The part drawn in front at this world point (as drawn in the last frame), or empty.
	UFUNCTION(BlueprintPure, Category = "Ugo9|Picking")
	FString PartAt(FVector WorldPoint, float MinOpacity = 0.01f) const;

	// The hit area at this world point ("head" for a part named "hit:head" or "当たり:head"), or empty.
	UFUNCTION(BlueprintPure, Category = "Ugo9|Picking")
	FString AreaAt(FVector WorldPoint) const;

	UFUNCTION(BlueprintPure, Category = "Ugo9|Picking")
	TArray<FString> GetAreaNames() const;

	// Where a ray (e.g. from the mouse: Convert Mouse Location to World Space) meets the character's plane.
	UFUNCTION(BlueprintPure, Category = "Ugo9|Picking")
	bool RayToPlane(FVector Origin, FVector Direction, FVector &WorldPoint) const;

	// The world box around a part (empty: the whole character) as drawn in the last frame. False: nothing there.
	UFUNCTION(BlueprintPure, Category = "Ugo9|Picking")
	bool PartBounds(const FString &Part, FBox &Box) const;

	// ---- bones in the world: attach things, reach for a point ----

	// Where the bone is in the world, and its turn (X along the bone, Y the plane's normal), as of the last frame.
	UFUNCTION(BlueprintPure, Category = "Ugo9|Bones")
	bool GetBoneTransform(const FString &Bone, FVector &Location, FRotator &Rotation) const;

	// This frame, turn the bone and up to Chain - 1 of its parents so its tip reaches the world point. Call every frame while it should.
	UFUNCTION(BlueprintCallable, Category = "Ugo9|Bones")
	void ReachFor(const FString &Bone, FVector WorldPoint, int32 Chain = 2);

	// model pixels (x right, y down) <-> world
	UFUNCTION(BlueprintPure, Category = "Ugo9")
	FVector2D WorldToModel(FVector WorldPoint) const;
	UFUNCTION(BlueprintPure, Category = "Ugo9")
	FVector ModelToWorld(FVector2D ModelPoint) const;

	virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction *ThisTickFunction) override;
	virtual void OnRegister() override;
	virtual void OnUnregister() override;

	// for the renderer: the last frame block (with the colour in its header) and the depth along Y
	const TArray<float> &LastFrame() const { return Frame; }
	float LastDepth() const { return Depth; }
	// models whose draw order changes (format 0.8): this frame's order (key 0: the stored one)
	uint32 LastDrawOrderKey() const { return DrawOrderKey; }
	const TArray<uint32> &LastDrawOrder() const { return DrawOrder; }
	bool HasFrame() const { return Frame.Num() > 0; }
	// runs the core now (the tick does it each frame)
	void UpdateNow(float DeltaTime = 0.0f);
	// the helpers' settings (parameter names, ranges, smoothing)
	ugo9core::Helpers &GetHelpers() { return Helpers; }

private:
	bool Ready();
	void Advance(float DeltaTime);
	float Upp() const;
	bool StartLayer(bool bQueue, int32 Layer, const FString &Name, float Fade, bool bAdditive, const TArray<FString> &MaskBones,
	                const TArray<FString> &MaskParts, const TArray<FString> &MaskParameters, float Weight, EUgoLoop Loop, float LayerSpeed);

	TUniquePtr<ugo9core::Instance> Instance;
	TSharedPtr<const ugo9core::Model> BuiltFor;
	TMap<int32, float> Overrides;
	TArray<float> Frame;
	float Depth = 0.0f;
	uint32 DrawOrderKey = 0;
	TArray<uint32> DrawOrder;

	// cross-fades and the queue of the main animation
	int32 FadeFromAnim = -1;
	float FadeFromTime = 0.0f, FadeT = 0.0f, FadeTotal = 0.0f;
	bool bFinished = false;
	FString FinishedFor;
	TArray<TPair<FString, float>> Queue;

	ugo9core::Layers Layers;
	ugo9core::Expressions Expressions;
	ugo9core::Helpers Helpers;
	ugo9core::VoiceGate Gate;
	FString ExpressionShown;
	TOptional<FVector> LookPoint;
	float VoiceDb = -100.0f;
	bool bVoice = false;
	struct FReach { int32 Bone, Chain; FVector2D Target; };
	TArray<FReach> Reach;
	// the lip-sync source's envelope (its delegate is bound while it is set)
	void BindLipSync();
	void OnEnvelope(const UAudioComponent *Source, const USoundWave *Wave, const float Value);
	TWeakObjectPtr<UAudioComponent> BoundSource;
	FDelegateHandle EnvelopeHandle;
	float Envelope = 0.0f;
	double EnvelopeAt = -1.0;
};
