//
//  IntentHandler.swift
//  HuddleIntents  (SiriKit Intents app extension — SCAFFOLD)
//
//  Principal class for Huddle's SiriKit messaging extension. This is what makes
//  "Hey Siri, send a message to Design on Huddle" work and lets CarPlay/Siri
//  read new Huddle messages aloud and take a dictated reply — the hands-free,
//  iMessage-parity path that CarPlay's on-screen templates can't provide.
//
//  ⚠️ SCAFFOLD — not yet wired into a build. This extension is a *separate*
//  target that must be added to the Xcode project, and its handlers talk to
//  Supabase directly (the RN JS isn't in this process). See the "Siri voice
//  messaging" section of mobile/docs/carplay.md for the remaining steps:
//    1. Add a "Messaging Intents Extension" target and set this as its
//       principal class (NSExtensionPrincipalClass).
//    2. Share the signed-in Supabase session with the extension via an App
//       Group (the RN app writes the access token; SupabaseMessaging reads it).
//    3. Implement the Supabase REST calls stubbed in SupabaseMessaging.swift.
//    4. Enable Siri + the App Group capability and register the plugin
//       (plugins/withSiriMessaging.js) in app.json.
//

import Intents

class IntentHandler: INExtension {
  override func handler(for intent: INIntent) -> Any {
    if intent is INSendMessageIntent {
      return SendMessageIntentHandler()
    }
    if intent is INSearchForMessagesIntent {
      return SearchForMessagesIntentHandler()
    }
    // INSetMessageAttributeIntent (mark as read) can be added here later.
    return self
  }
}
