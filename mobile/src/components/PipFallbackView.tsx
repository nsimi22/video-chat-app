import { Text, View } from 'react-native';
import { Avatar } from '@/components/ui';
import { colors, space } from '@/theme';

// Static "audio only" panel shown inside the iOS Picture-in-Picture
// window when the live video isn't available — specifically when iOS
// has suspended local camera capture because the app is backgrounded.
//
// The native PIPController swaps its AVSampleBufferDisplayLayer for
// this view's UIView counterpart the moment its videoTrack property
// goes to nil. We hand it over via `iosPIP.fallbackView`, with the
// call site clearing `trackRef` to undefined to trigger the swap.
//
// No interactivity — iOS doesn't relay touches into PiP-window JS.
// Tapping the PiP window pops it back into the app via iOS itself.

export function PipFallbackView({ name }: { name: string }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: '#000',
        alignItems: 'center',
        justifyContent: 'center',
        padding: space(2),
      }}
    >
      <Avatar name={name} size={48} />
      <Text
        style={{
          color: colors.textDim,
          fontSize: 11,
          marginTop: space(2),
          textAlign: 'center',
        }}
        numberOfLines={1}
      >
        Audio only
      </Text>
    </View>
  );
}
