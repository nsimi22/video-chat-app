// IMPORTANT: registerGlobals must come from @livekit/react-native, NOT
// from @livekit/react-native-webrtc. The LiveKit wrapper does
// everything the raw WebRTC version does *plus* the bits that make
// publishing work on iOS:
//   - patches getUserMedia to set the iOS audio category to
//     `playAndRecord` before grabbing the mic (default is `playback`,
//     which silently blocks the mic publish)
//   - registers livekit-client's native-platform hooks
//   - installs URL, Promise.allSettled, crypto.randomUUID, WebStream
//     and DOMException polyfills the SDK relies on
//   - wires the native event bridge
// Importing from `@livekit/react-native-webrtc` got us a partial setup
// where the room would connect but setCameraEnabled / setMicrophoneEnabled
// would silently no-op despite permissions being granted.
import { registerGlobals } from '@livekit/react-native';

registerGlobals();

import 'expo-router/entry';
