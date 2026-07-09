// Expo config plugin that wires up CarPlay for the iOS app.
//
// CarPlay is not a separate app — it's a surface inside the existing iOS app,
// gated on a category entitlement Apple grants manually. Huddle is a
// communication (VoIP) app, so it targets the **Communication** CarPlay
// category, which is audio-only (Apple forbids video on the car screen).
//
// CONNECTION METHOD — AppDelegate (`CPApplicationDelegate`), NOT UIScene.
// This is the path react-native-carplay documents. We intentionally do NOT add
// a UIApplicationSceneManifest / UIApplicationSupportsMultipleScenes: in a
// prebuilt Expo SDK 54 / RN 0.81 app, enabling multiple scenes without a
// matching UIWindowScene delegate leaves the phone's AppDelegate-created window
// unattached and the entire app renders black. Keeping the app AppDelegate/
// window based avoids that; CarPlay attaches through the CPWindow handed to the
// connect callback.
//
// This plugin performs the two native steps `expo prebuild` can't infer:
//
//   1. Entitlement — adds `com.apple.developer.carplay-communication`. (Apple
//      still has to approve the CarPlay capability on the App ID / provisioning
//      profile; this plugin just declares intent so the build is ready.)
//   2. CarPlay connector — copies ios-carplay/AppDelegate+HuddleCarPlay.m into
//      the generated iOS project and adds it to the app target's sources. It is
//      an ObjC category on the (Swift) AppDelegate that implements the
//      CPApplicationDelegate connect/disconnect callbacks and forwards them to
//      react-native-carplay's RNCarPlay bridge.
//
// The JS that actually drives the templates lives in src/lib/carplay.ts +
// src/components/CarPlayBridge.tsx and needs no native knowledge beyond this.
//
// Requires the `react-native-carplay` pod (added to package.json) so RNCarPlay
// is available to the category.

const fs = require('fs');
const path = require('path');
const { withEntitlementsPlist, withXcodeProject, IOSConfig } = require('@expo/config-plugins');

const CARPLAY_ENTITLEMENT = 'com.apple.developer.carplay-communication';
const CONNECTOR = 'AppDelegate+HuddleCarPlay';
const SOURCE_DIR = 'ios-carplay';

function withCarPlayEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults[CARPLAY_ENTITLEMENT] = true;
    return cfg;
  });
}

function withCarPlayConnector(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const { projectName, platformProjectRoot, projectRoot } = cfg.modRequest;
    if (!projectName) {
      console.warn('[withCarPlay] no projectName; skipping CarPlay connector injection');
      return cfg;
    }

    const from = path.join(projectRoot, SOURCE_DIR, `${CONNECTOR}.m`);
    const to = path.join(platformProjectRoot, projectName, `${CONNECTOR}.m`);
    // Overwrite each prebuild so edits to the source-of-truth in ios-carplay/
    // propagate.
    try {
      fs.copyFileSync(from, to);
    } catch (err) {
      console.warn(`[withCarPlay] failed to copy ${CONNECTOR}.m:`, err.message);
    }

    // Register the .m in the app target's Compile Sources.
    const rel = `${projectName}/${CONNECTOR}.m`;
    try {
      if (!project.hasFile(rel)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath: rel,
          groupName: projectName,
          project,
        });
      }
    } catch (err) {
      console.warn(
        `[withCarPlay] could not add ${rel} to the Xcode project — add it manually in Xcode ` +
          `(Target → Build Phases → Compile Sources). Reason: ${err.message}`,
      );
    }

    return cfg;
  });
}

module.exports = function withCarPlay(config) {
  config = withCarPlayEntitlement(config);
  config = withCarPlayConnector(config);
  return config;
};
