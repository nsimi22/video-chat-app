//
//  SearchForMessagesIntentHandler.swift
//  HuddleIntents  (SCAFFOLD)
//
//  Handles INSearchForMessagesIntent — the intent Siri uses to read a user's
//  unread messages aloud (e.g. CarPlay "Announce Messages", or "read my Huddle
//  messages"). Returns INMessage objects Siri speaks.
//
//  ⚠️ SCAFFOLD. The fetch is stubbed against SupabaseMessaging. See docs/carplay.md.
//

import Intents

class SearchForMessagesIntentHandler: NSObject, INSearchForMessagesIntentHandling {
  func handle(
    intent: INSearchForMessagesIntent,
    completion: @escaping (INSearchForMessagesIntentResponse) -> Void
  ) {
    guard SupabaseMessaging.shared.hasSession else {
      completion(INSearchForMessagesIntentResponse(code: .failureRequiringAppLaunch, userActivity: nil))
      return
    }

    // TODO: fetch unread messages from Supabase and map them to INMessage.
    SupabaseMessaging.shared.fetchUnreadMessages { messages in
      let inMessages: [INMessage] = messages.map { m in
        let sender = INPerson(
          personHandle: INPersonHandle(value: m.senderId, type: .unknown),
          nameComponents: nil,
          displayName: m.senderName,
          image: nil,
          contactIdentifier: nil,
          customIdentifier: m.senderId
        )
        return INMessage(
          identifier: m.id,
          content: m.body,
          dateSent: m.sentAt,
          sender: sender,
          recipients: nil
        )
      }
      let response = INSearchForMessagesIntentResponse(code: .success, userActivity: nil)
      response.messages = inMessages
      completion(response)
    }
  }
}
