//
//  SendMessageIntentHandler.swift
//  HuddleIntents  (SCAFFOLD)
//
//  Handles INSendMessageIntent — "send <text> to <recipient> on Huddle",
//  including the dictated reply after Siri reads a message aloud in the car.
//
//  ⚠️ SCAFFOLD. Recipient resolution and the actual send are stubbed against
//  SupabaseMessaging (which itself is a stub). See docs/carplay.md.
//

import Intents

class SendMessageIntentHandler: NSObject, INSendMessageIntentHandling {

  // Resolve the recipients Siri parsed against the user's Huddle channels/DMs.
  func resolveRecipients(
    for intent: INSendMessageIntent,
    with completion: @escaping ([INSendMessageRecipientResolutionResult]) -> Void
  ) {
    guard let recipients = intent.recipients, !recipients.isEmpty else {
      completion([INSendMessageRecipientResolutionResult.needsValue()])
      return
    }
    // TODO: match each `recipient.displayName` against the team's channels/DMs
    // (SupabaseMessaging.resolveConversation) and disambiguate when more than
    // one matches. For the scaffold we accept whatever Siri parsed.
    let results = recipients.map { INSendMessageRecipientResolutionResult.success(with: $0) }
    completion(results)
  }

  func resolveContent(
    for intent: INSendMessageIntent,
    with completion: @escaping (INStringResolutionResult) -> Void
  ) {
    if let text = intent.content, !text.isEmpty {
      completion(.success(with: text))
    } else {
      completion(.needsValue())
    }
  }

  func confirm(
    intent: INSendMessageIntent,
    completion: @escaping (INSendMessageIntentResponse) -> Void
  ) {
    // Signal readiness; requires an authenticated session shared from the app.
    guard SupabaseMessaging.shared.hasSession else {
      completion(INSendMessageIntentResponse(code: .failureRequiringAppLaunch, userActivity: nil))
      return
    }
    completion(INSendMessageIntentResponse(code: .ready, userActivity: nil))
  }

  func handle(
    intent: INSendMessageIntent,
    completion: @escaping (INSendMessageIntentResponse) -> Void
  ) {
    guard
      let text = intent.content,
      let recipientName = intent.recipients?.first?.displayName
    else {
      completion(INSendMessageIntentResponse(code: .failure, userActivity: nil))
      return
    }

    // TODO: resolve the recipient to a channel id, then POST the message.
    SupabaseMessaging.shared.sendMessage(to: recipientName, body: text) { success in
      let code: INSendMessageIntentResponseCode = success ? .success : .failure
      completion(INSendMessageIntentResponse(code: code, userActivity: nil))
    }
  }
}
