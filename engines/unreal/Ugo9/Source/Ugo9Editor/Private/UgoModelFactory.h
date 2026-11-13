/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// Drag a .ug9 into the Content Browser: it becomes a UUgoModelAsset, with the atlas PNGs it names
// (looked for next to the .ug9) kept inside it. Reimport reads the same files again.
#pragma once

#include "CoreMinimal.h"
#include "Factories/Factory.h"
#include "EditorReimportHandler.h"

#include "UgoModelFactory.generated.h"

UCLASS()
class UUgoModelFactory : public UFactory, public FReimportHandler
{
	GENERATED_BODY()

public:
	UUgoModelFactory();

	virtual UObject *FactoryCreateBinary(UClass *InClass, UObject *InParent, FName InName, EObjectFlags Flags, UObject *Context,
		const TCHAR *Type, const uint8 *&Buffer, const uint8 *BufferEnd, FFeedbackContext *Warn) override;

	// reimport
	virtual bool CanReimport(UObject *Obj, TArray<FString> &OutFilenames) override;
	virtual void SetReimportPaths(UObject *Obj, const TArray<FString> &NewReimportPaths) override;
	virtual EReimportResult::Type Reimport(UObject *Obj) override;
};
