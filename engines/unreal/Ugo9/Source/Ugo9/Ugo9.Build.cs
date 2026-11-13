// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The runtime module: the Ugo9 core (C, compiled into the module as it is) and the classes that use it.
// The core's sources are copied into Private/UgoCore/ from the repository's core/ when the plugin is
// built inside the repository (engines/unreal/Ugo9); a copy of the plugin made by
// engines/unreal/package_plugin.mjs carries them already.
using System.IO;
using UnrealBuildTool;

public class Ugo9 : ModuleRules
{
	public Ugo9(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new string[] { "Projects", "RenderCore", "Renderer", "RHI", "ImageWrapper", "Json", "InputCore" });
		// FViewInfo (the view's rectangle in the scene textures) for the pass that draws the characters
		PrivateIncludePaths.Add(Path.Combine(EngineDirectory, "Source", "Runtime", "Renderer", "Private"));

		string copy = Path.Combine(ModuleDirectory, "Private", "UgoCore");
		string repoCore = Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "..", "..", "..", "core"));
		if (File.Exists(Path.Combine(repoCore, "src", "ugo.c")))
		{
			Directory.CreateDirectory(copy);
			// ugo.c and every header of the core (a new header, such as the SIMD one, comes along by itself)
			var files = new System.Collections.Generic.List<string> { "src/ugo.c" };
			foreach (string dir in new string[] { "src", "include" })
				foreach (string h in Directory.GetFiles(Path.Combine(repoCore, dir), "*.h"))
					files.Add(dir + "/" + Path.GetFileName(h));
			foreach (string f in files)
			{
				string from = Path.Combine(repoCore, f), to = Path.Combine(copy, Path.GetFileName(f));
				if (!File.Exists(to) || File.ReadAllText(to) != File.ReadAllText(from)) File.Copy(from, to, true);
			}
		}
		if (!File.Exists(Path.Combine(copy, "ugo.c")))
		{
			throw new BuildException("Ugo9: the core's C sources are missing in " + copy + ": make the plugin with node engines/unreal/package_plugin.mjs <your project>/Plugins");
		}
		PrivateIncludePaths.Add(copy);
	}
}
