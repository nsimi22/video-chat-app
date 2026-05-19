// react-native-webrtc installs WebRTC globals (RTCPeerConnection, MediaStream,
// mediaDevices, etc.) and patches the necessary DOM-ish surface. Must run
// before any module that touches them — hence top of the entry point.
import { registerGlobals } from 'react-native-webrtc';

if (typeof global.DOMException === 'undefined') {
  global.DOMException = class DOMException extends Error {
    constructor(message, name = 'DOMException') {
      super(message);
      this.name = name;
    }
  };
}

registerGlobals();

import 'expo-router/entry';
