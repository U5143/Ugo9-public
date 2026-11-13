/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// Automation tests (Session Frontend → Automation → Ugo9, or -ExecCmds="Automation RunTests Ugo9"):
// the core inside Unreal, on the repository's samples/basic (the plugin inside the repository).
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Interfaces/IPluginManager.h"
#include "UgoModelAsset.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUgo9CoreTest, "Ugo9.Core.LoadAndPose", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUgo9CoreTest::RunTest(const FString &Parameters)
{
	// the plugin made by package_plugin.mjs carries samples/basic; inside the repository it is three folders up
	TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("Ugo9"));
	const FString Base = Plugin.IsValid() ? Plugin->GetBaseDir() : FString();
	FString File = FPaths::Combine(Base, TEXT("Resources/Samples/basic/model.ug9"));
	if (!FPaths::FileExists(File)) File = FPaths::Combine(Base, TEXT("../../../samples/basic/model.ug9"));
	TArray<uint8> Bytes;
	if (Base.IsEmpty() || !FFileHelper::LoadFileToArray(Bytes, *File))
	{
		AddWarning(FString::Printf(TEXT("samples/basic not found at %s (the plugin is not inside the repository): skipped"), *File));
		return true;
	}
	UUgoModelAsset *Asset = NewObject<UUgoModelAsset>();
	FString Error;
	TestTrue(TEXT("samples/basic loads"), Asset->SetData(Bytes, Error));
	TestTrue(TEXT("names"), Asset->GetParameterNames().Contains(TEXT("HeadTurnX")) && Asset->GetAnimationNames().Contains(TEXT("idle")));
	float Min, Max, Default, Duration;
	bool bLoops;
	Asset->GetParameterRange(TEXT("HeadTurnX"), Min, Max, Default);
	Asset->GetAnimationInfo(TEXT("idle"), Duration, bLoops);
	TestTrue(TEXT("HeadTurnX -30..30, idle 6 s looping"), Min == -30 && Max == 30 && Default == 0 && FMath::IsNearlyEqual(Duration, 6.0f) && bLoops);

	ugo9core::Instance A(*Asset->Core()), B(*Asset->Core());
	const int Idle = Asset->Core()->FindAnimation("idle"), HeadTurnX = Asset->Core()->FindParameter("HeadTurnX");
	A.ResetParams(); A.ApplyAnimation(Idle, 1.3f, 1); A.Update(0);
	B.ResetParams(); B.ApplyAnimation(Idle, 1.3f, 1); B.SetParam(HeadTurnX, 25); B.Update(0);
	bool bDiffer = false;
	for (uint32 i = 0; i < Asset->Core()->FrameFloats(); i++) bDiffer |= A.Frame()[i] != B.Frame()[i];
	TestTrue(TEXT("a parameter changes the frame block"), bDiffer);
	A.ResetParams(); A.Update(0);
	TestEqual(TEXT("the face is under its middle"), FString(UTF8_TO_TCHAR(Asset->Core()->PartNames()[FMath::Max(0, A.PickPart(0, -330))].c_str())), FString(TEXT("face")));

	TArray<uint8> Other = Bytes;
	Other[4] = 9;
	TestFalse(TEXT("another major version does not load"), Asset->SetData(Other, Error));
	TestTrue(TEXT("and says to update the plugin"), Error.Contains(TEXT("update the Ugo9 plugin")));
	return true;
}

#endif
