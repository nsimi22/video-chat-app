// Expo config plugin that wires up CarPlay for the iOS app.
//
// CarPlay is not a separate app — it's a scene inside the existing iOS app,
// gated on a category entitlement Apple grants manually. Huddle is a
// communication (VoIP) app, so it targets the **Communication** CarPlay
// category, which is audio-only (Apple forbids video on the car screen).
//
// This plugin performs the three native steps `expo prebuild` can't infer:
//
//   1. Entitlement — adds `com.apple.developer.carplay-communication`. (Apple
//      still has to approve the CarPlay capability on the App ID / provisioning
//      profile; this plugin just declares intent so the build is ready.)
//   2. Info.plist — declares a CarPlay template scene
//      (CPTemplateApplicationSceneSessionRoleApplication) pointing at the
//      HuddleCarSceneDelegate class. The phone UI keeps its normal
//      AppDelegate-owned window (we intentionally don't declare a
//      UIWindowSceneSessionRoleApplication).
//   3. Scene delegate — copies ios-carplay/HuddleCarSceneDelegate.{h,m} into the
//      generated iOS project and adds the .m to the app target's sources, so
//      react-native-carplay's RNCarPlay bridge receives the CarPlay interface
//      controller on connect.
//
// The JS that actually drives the templates lives in src/lib/carplay.ts +
// src/components/CarPlayBridge.tsx and needs no native knowledge beyond this.
//
// Requires the `react-native-carplay` pod (added to package.json) so RNCarPlay
// is available to the scene delegate.

const fs = require('fs');
const path = require('path');
const {
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
  IOSConfig,
} = require('@expo/config-plugins');

const CARPLAY_ENTITLEMENT = 'com.apple.developer.carplay-communication';
const DELEGATE_CLASS = 'HuddleCarSceneDelegate';
const SCENE_CONFIG_NAME = 'CarPlay';
const SOURCE_DIR = 'ios-carplay';

function withCarPlayEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults[CARPLAY_ENTITLEMENT] = true;
    return cfg;
  });
}

function withCarPlaySceneManifest(config) {
  return withInfoPlist(config, (cfg) => {
    const info = cfg.modResults;
    const manifest = info.UIApplicationSceneManifest || {};
    // Multiple scenes must be enabled for the car scene to coexist with the
    // phone app. We don't add a UIWindowSceneSessionRoleApplication, so the RN
    // AppDelegate keeps creating the phone window the classic way.
    manifest.UIApplicationSupportsMultipleScenes = true;
    const sceneConfigs = manifest.UISceneConfigurations || {};
    const carRole = 'CPTemplateApplicationSceneSessionRoleApplication';
    const existing = Array.isArray(sceneConfigs[carRole]) ? sceneConfigs[carRole] : [];
    const already = existing.some((c) => c && c.UISceneConfigurationName === SCENE_CONFIG_NAME);
    if (!already) {
      existing.push({
        UISceneConfigurationName: SCENE_CONFIG_NAME,
        UISceneDelegateClassName: DELEGATE_CLASS,
      });
    }
    sceneConfigs[carRole] = existing;
    manifest.UISceneConfigurations = sceneConfigs;
    info.UIApplicationSceneManifest = manifest;
    return cfg;
  });
}

function withCarPlaySceneDelegate(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const { projectName, platformProjectRoot, projectRoot } = cfg.modRequest;
    if (!projectName) {
      console.warn('[withCarPlay] no projectName; skipping scene delegate injection');
      return cfg;
    }

    const srcDir = path.join(projectRoot, SOURCE_DIR);
    const destDir = path.join(platformProjectRoot, projectName);

    // Copy the delegate sources into ios/<projectName>/. Overwrite each prebuild
    // so edits to the source-of-truth in ios-carplay/ propagate.
    for (const file of [`${DELEGATE_CLASS}.h`, `${DELEGATE_CLASS}.m`]) {
      const from = path.join(srcDir, file);
      const to = path.join(destDir, file);
      try {
        fs.copyFileSync(from, to);
      } catch (err) {
        console.warn(`[withCarPlay] failed to copy ${file}:`, err.message);
      }
    }

    // Register the .m in the app target's Compile Sources. The .h resolves via
    // the .m's same-directory quote-include, so it needs no build-phase entry.
    const relM = `${projectName}/${DELEGATE_CLASS}.m`;
    try {
      if (!project.hasFile(relM)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath: relM,
          groupName: projectName,
          project,
        });
      }
    } catch (err) {
      console.warn(
        `[withCarPlay] could not add ${relM} to the Xcode project — add it manually in Xcode ` +
          `(Target → Build Phases → Compile Sources). Reason: ${err.message}`,
      );
    }

    return cfg;
  });
}

module.exports = function withCarPlay(config) {
  config = withCarPlayEntitlement(config);
  config = withCarPlaySceneManifest(config);
  config = withCarPlaySceneDelegate(config);
  return config;
};
