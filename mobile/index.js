import { registerGlobals } from '@livekit/react-native-webrtc';

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
