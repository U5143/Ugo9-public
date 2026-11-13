/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "Modules/ModuleManager.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "ShaderCore.h"

// The plugin's shaders as /Plugin/Ugo9/... (loaded at PostConfigInit, before shaders compile).
class FUgo9Module : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("Ugo9"));
		if (Plugin.IsValid()) AddShaderSourceDirectoryMapping(TEXT("/Plugin/Ugo9"), FPaths::Combine(Plugin->GetBaseDir(), TEXT("Shaders")));
	}
};

IMPLEMENT_MODULE(FUgo9Module, Ugo9)
