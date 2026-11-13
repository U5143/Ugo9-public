/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "UgoModelFactory.h"

#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/FeedbackContext.h"
#include "UgoModelAsset.h"

// the model's bytes and the atlas images it names, from the folder of the .ug9
static bool Fill(UUgoModelAsset *Asset, const TArray<uint8> &Bytes, const FString &File, FFeedbackContext *Warn)
{
	FString Error;
	if (!Asset->SetData(Bytes, Error))
	{
		if (Warn) Warn->Logf(ELogVerbosity::Error, TEXT("%s: %s"), *File, *Error);
		return false;
	}
	Asset->SourceFile = File;
	Asset->Atlases.Reset();
	Asset->ForgetAtlasTextures();
	const FString Dir = FPaths::GetPath(File);
	for (const FString &Name : Asset->GetTextureNames())
	{
		FUgoAtlasFile Atlas;
		Atlas.Name = Name;
		const FString Path = FPaths::Combine(Dir, Name);
		if (!FFileHelper::LoadFileToArray(Atlas.Bytes, *Path) && Warn)
		{
			Warn->Logf(ELogVerbosity::Warning, TEXT("Ugo9: the atlas %s is not next to %s (the model draws without it): put the PNGs the editor wrote beside the .ug9 and reimport"), *Name, *File);
		}
		Asset->Atlases.Add(MoveTemp(Atlas));
	}
	return true;
}

UUgoModelFactory::UUgoModelFactory()
{
	SupportedClass = UUgoModelAsset::StaticClass();
	bCreateNew = false;
	bEditorImport = true;
	bText = false;
	Formats.Add(TEXT("ug9;Ugo9 model"));
	Formats.Add(TEXT("ugo;Ugo9 model (before 1.0)"));
}

UObject *UUgoModelFactory::FactoryCreateBinary(UClass *InClass, UObject *InParent, FName InName, EObjectFlags Flags, UObject *Context,
	const TCHAR *Type, const uint8 *&Buffer, const uint8 *BufferEnd, FFeedbackContext *Warn)
{
	TArray<uint8> Bytes;
	Bytes.Append(Buffer, (int32)(BufferEnd - Buffer));
	UUgoModelAsset *Asset = NewObject<UUgoModelAsset>(InParent, InClass, InName, Flags);
	if (!Fill(Asset, Bytes, UFactory::CurrentFilename, Warn)) return nullptr;
	return Asset;
}

bool UUgoModelFactory::CanReimport(UObject *Obj, TArray<FString> &OutFilenames)
{
	const UUgoModelAsset *Asset = Cast<UUgoModelAsset>(Obj);
	if (!Asset) return false;
	OutFilenames.Add(Asset->SourceFile);
	return true;
}

void UUgoModelFactory::SetReimportPaths(UObject *Obj, const TArray<FString> &NewReimportPaths)
{
	UUgoModelAsset *Asset = Cast<UUgoModelAsset>(Obj);
	if (Asset && NewReimportPaths.Num() == 1) Asset->SourceFile = NewReimportPaths[0];
}

EReimportResult::Type UUgoModelFactory::Reimport(UObject *Obj)
{
	UUgoModelAsset *Asset = Cast<UUgoModelAsset>(Obj);
	if (!Asset) return EReimportResult::Failed;
	TArray<uint8> Bytes;
	if (!FFileHelper::LoadFileToArray(Bytes, *Asset->SourceFile)) return EReimportResult::Failed;
	if (!Fill(Asset, Bytes, Asset->SourceFile, GWarn)) return EReimportResult::Failed;
	Asset->MarkPackageDirty();
	return EReimportResult::Succeeded;
}
