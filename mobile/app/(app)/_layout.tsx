import { useEffect } from 'react';
import { View } from 'react-native';
import { Stack, router, useSegments } from 'expo-router';
import { LiveKitRoom, useLocalParticipant } from '@livekit/react-native';
import { useAuth } from '@/context/AuthContext';
import { CallProvider, useCall } from '@/context/CallContext';
import { CallSignalsProvider } from '@/context/CallSignalsContext';
import { UnreadProvider } from '@/context/UnreadContext';
import { MutedChannelsProvider } from '@/context/MutedChannelsContext';
import { FavoritesProvider } from '@/context/FavoritesContext';
import { PresenceProvider } from '@/context/PresenceContext';
import { BiometricLockScreen } from '@/components/BiometricLockScreen';
import { FloatingCall } from '@/components/FloatingCall';
import { registerForPush } from '@/lib/push';
import { colors } from '@/theme';

export default function AppLayout() {
  const { loading, session, activeTeam, userId, locked } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!session) router.replace('/(auth)/email');
    else if (!activeTeam) router.replace('/(auth)/team');
  }, [loading, session, activeTeam]);

  // Gate the entire (app) tree on biometric unlock when the user has opted
  // in. Rendered before any of the providers so push registration and call
  // setup don't run for a locked session.
  if (session && locked) return <BiometricLockScreen />;

  useEffect(() => {
    if (!userId) return;
    // Surface failures to the console — push registration is the most
    // common silent failure mode (permission gate, missing projectId,
    // device_tokens RLS, expired Expo project). Logging here is the
    // first place a "push doesn't work" report lands.
    registerForPush(userId).catch((err) => {
      console.error('[push] registerForPush failed at app layout:', err);
    });
  }, [userId]);

  // CallProvider has to wrap the navigator so /(app)/call/[id] can
  // call useCall() to read activeCall and the floater (rendered as a
  // layout-level sibling) can stay mounted across route changes.
  // CallRoomShell then conditionally wraps the navigator in
  // <LiveKitRoom> whenever a call is active, so the room (and its
  // peer connection) survives navigating between channels.
  // UnreadProvider sits inside CallProvider because it also needs to
  // outlive route changes — its single team-wide realtime subscription
  // would otherwise tear down + re-establish every time the user
  // navigates between the channels list and a channel.
  return (
    <CallProvider>
      <CallSignalsProvider>
      <MutedChannelsProvider>
        <UnreadProvider>
          <FavoritesProvider>
          <PresenceProvider>
          <CallRoomShell>
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.surface },
              headerTintColor: colors.text,
              contentStyle: { backgroundColor: colors.bg },
              // expo-router 6 / React Navigation 7 surfaces the parent route's
              // name as the back-button label; without this, pushing from
              // (tabs) shows the literal string "(tabs)" next to the chevron.
              // `minimal` is the RN-Nav-7 idiomatic way (forces chevron-only);
              // headerBackTitle:'' alone wasn't enough on iOS 26.
              headerBackButtonDisplayMode: 'minimal',
              headerBackTitle: '',
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="channel/[id]" options={{ title: '' }} />
            <Stack.Screen
              name="call/[id]"
              options={{
                // headerShown declared once here so the call screen never has to
                // toggle it at runtime. Modal screens that change header visibility
                // mid-render get remounted by react-native-screens, which
                // unmounts LiveKitRoom and kills the in-flight signal connection.
                headerShown: false,
                presentation: 'fullScreenModal',
              }}
            />
            <Stack.Screen name="event/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="thread/[id]" options={{ title: 'Thread' }} />
          </Stack>
          <FloatingCallOverlay />
        </View>
      </CallRoomShell>
          </PresenceProvider>
          </FavoritesProvider>
        </UnreadProvider>
      </MutedChannelsProvider>
      </CallSignalsProvider>
    </CallProvider>
  );
}

// Wrap the navigator + floater in <LiveKitRoom> permanently — connect
// is gated on activeCall+perms, so when there's no call the room
// instance sits idle (no socket, no media). Doing it this way matters:
// the previous "conditionally render LiveKitRoom" version meant the
// JSX type of CallRoomShell's child changed (Fragment → LiveKitRoom)
// the instant a call started, which causes react-native-screens to
// rebuild the entire Stack and bounces the user to (tabs) mid-startCall.
// They'd then see the floater on the channels list because activeCall
// was set — exactly the "starts in PiP mode" bug reported on #150.
// Stamps `platform: "mobile"` on the LiveKit participant metadata once
// the local participant is connected. Desktop viewers read this via
// `participant.metadata` (renderer/livekit.js _parsePlatform) to render
// the "Mobile" pip + phone-frame outline on this participant's tile
// (UI v2 design items 2.4 + 5.1, shipped in PR #179). Idempotent —
// useEffect only fires when localParticipant.identity changes
// (= connect / reconnect). Lives as a child of <LiveKitRoom> so the
// useLocalParticipant() hook has a Room context to read from.
function PlatformMetadataPublisher() {
  const { localParticipant } = useLocalParticipant();
  useEffect(() => {
    if (!localParticipant) return;
    // setMetadata resolves via a signal-server round-trip, so failures
    // (request timeout, token missing canUpdateOwnMetadata) reject the
    // PROMISE — a sync try/catch never sees them and the rejection
    // surfaced as an unhandled SignalRequestError red-box. Non-fatal
    // either way: the pip just won't render on desktop tiles.
    Promise.resolve(localParticipant.setMetadata(JSON.stringify({ platform: 'mobile' })))
      .catch((err) => console.warn('[livekit] setMetadata failed', err));
  }, [localParticipant?.identity]);
  return null;
}

function CallRoomShell({ children }: { children: React.ReactNode }) {
  const { activeCall, perms, endCall } = useCall();
  const ready = !!activeCall && !!perms;
  return (
    <LiveKitRoom
      serverUrl={ready ? activeCall!.grant.url : undefined}
      token={ready ? activeCall!.grant.token : undefined}
      connect={ready}
      audio={ready ? perms!.mic : false}
      video={ready ? perms!.camera : false}
      options={{ adaptiveStream: { pixelDensity: 'screen' } }}
      // Server-side disconnect (kicked, network drop, room closed)
      // should also reset our state so the floater disappears and the
      // call screen, if visible, navigates back.
      onDisconnected={endCall}
    >
      <PlatformMetadataPublisher />
      {children}
    </LiveKitRoom>
  );
}

// Hide the floater when the user is already on the full call screen
// (no point doubling the video), or when there's no active call.
function FloatingCallOverlay() {
  const { activeCall } = useCall();
  const segments = useSegments();
  if (!activeCall) return null;
  // segments is an array like ['(app)', 'call', '[id]'] (group prefix
  // included on expo-router v6). The 'call' check covers it whether
  // the group is included or not.
  if (segments.some((s) => s === 'call')) return null;
  return <FloatingCall />;
}
