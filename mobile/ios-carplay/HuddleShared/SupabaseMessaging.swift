//
//  SupabaseMessaging.swift
//  HuddleShared  (SCAFFOLD)
//
//  Minimal Supabase messaging client for the SiriKit extension. The extension
//  runs in its own process and can't reach the React Native JS, so send/fetch go
//  straight to Supabase's REST + auth endpoints from Swift.
//
//  Auth is shared from the RN app via an **App Group**: on sign-in the app
//  writes the current Supabase access token (and active team id) into the shared
//  UserDefaults suite; this client reads them. See docs/carplay.md for the RN
//  side (a small native module writing `group.<bundle>` defaults).
//
//  ⚠️ SCAFFOLD — the network calls are stubbed. Fill in the marked TODOs.
//

import Foundation

struct HuddleMessage {
  let id: String
  let senderId: String
  let senderName: String
  let body: String
  let sentAt: Date
}

final class SupabaseMessaging {
  static let shared = SupabaseMessaging()

  // Must match the App Group id declared in the extension + app entitlements and
  // in plugins/withSiriMessaging.js.
  private let appGroupId = "group.com.nicksimi.huddle"

  // Public Supabase project values (same as app.json → expo.extra).
  private let supabaseUrl = "https://jwqvrdgjpftjiwvgdrck.supabase.co"
  private let supabaseAnonKey = "sb_publishable_5eJWwJEHWHSLuhFEs2iUlw_tu4fGOvn"

  private var defaults: UserDefaults? { UserDefaults(suiteName: appGroupId) }

  /// Access token written by the RN app on sign-in (see docs/carplay.md).
  private var accessToken: String? { defaults?.string(forKey: "supabase_access_token") }
  private var teamId: String? { defaults?.string(forKey: "active_team_id") }
  private var userId: String? { defaults?.string(forKey: "user_id") }

  var hasSession: Bool { accessToken != nil && teamId != nil }

  // MARK: - Send

  /// Resolve `recipientName` to a channel id, then POST a message row.
  func sendMessage(to recipientName: String, body: String, completion: @escaping (Bool) -> Void) {
    guard let token = accessToken, let team = teamId, let author = userId else {
      completion(false)
      return
    }
    // TODO:
    //   1. GET /rest/v1/channels?team_id=eq.<team> and match `recipientName`
    //      against channel names / DM peer names to find the channel id.
    //   2. POST /rest/v1/messages with { team_id, channel_id, author_id: author,
    //      body, attachments: [], mentions: [], reactions: {} } and headers
    //      Authorization: Bearer <token>, apikey: anonKey, Prefer: return=minimal.
    // Mirrors src/lib/api.ts sendMessage().
    _ = (token, team, author, recipientName, body)
    completion(false)
  }

  // MARK: - Fetch unread

  /// Fetch recent messages for Siri to read aloud.
  func fetchUnreadMessages(completion: @escaping ([HuddleMessage]) -> Void) {
    guard accessToken != nil, teamId != nil else {
      completion([])
      return
    }
    // TODO: GET /rest/v1/messages?team_id=eq.<team>&parent_id=is.null
    //       &order=ts.desc&limit=10 with the same auth headers, join author
    //       names via profiles/get_profile, and map rows → HuddleMessage.
    completion([])
  }
}
