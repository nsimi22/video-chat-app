// Expo config plugin for the SiriKit voice-messaging scaffold (main-app side).
//
// ⚠️ NOT registered in app.json by default. Enabling Siri requires the Siri
// capability on the App ID / provisioning profile, and an App Group — adding the
// entitlement without those set up will fail code signing. Turn this on only
// after you've created the Intents extension target and enabled the
// capabilities (see the "Siri voice messaging" section of docs/carplay.md), by
// adding "./plugins/withSiriMessaging.js" to the app.json `plugins` array.
//
// This plugin handles the DECLARATIVE main-app changes only:
//   • com.apple.developer.siri entitlement,
//   • NSSiriUsageDescription usage string,
//   • the App Group the RN app + extension share the Supabase session through.
//
// It does NOT create the extension target — @expo/config-plugins can't reliably
// add a new app-extension target to the pbxproj. That step is manual (or via a
// dedicated tool); the extension sources live in ios-carplay/HuddleIntents/.

const { withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');

const APP_GROUP = 'group.com.nicksimi.huddle';
const SIRI_USAGE =
  'Huddle uses Siri so you can send and hear messages hands-free, including in CarPlay.';

function withSiriEntitlements(config) {
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['com.apple.developer.siri'] = true;
    const groups = cfg.modResults['com.apple.security.application-groups'] || [];
    if (!groups.includes(APP_GROUP)) groups.push(APP_GROUP);
    cfg.modResults['com.apple.security.application-groups'] = groups;
    return cfg;
  });
}

function withSiriUsageDescription(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.NSSiriUsageDescription = cfg.modResults.NSSiriUsageDescription || SIRI_USAGE;
    return cfg;
  });
}

module.exports = function withSiriMessaging(config) {
  config = withSiriEntitlements(config);
  config = withSiriUsageDescription(config);
  return config;
};
