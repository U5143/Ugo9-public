// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The editor module: importing .ug9 files (and the atlas PNGs they name) as UUgoModelAsset.
using UnrealBuildTool;

public class Ugo9Editor : ModuleRules
{
	public Ugo9Editor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PrivateDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "UnrealEd", "Ugo9" });
	}
}
