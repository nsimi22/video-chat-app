import { Image, Modal, Platform, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { space } from '@/theme';

// Full-screen viewer for an inline image attachment. Tapping a thumbnail
// in the chat list opens this; backdrop tap or close-button dismisses.
//
// iOS gets free pinch-to-zoom via UIScrollView's built-in
// minimumZoomScale / maximumZoomScale — the ScrollView wrapper sets
// those and iOS handles the gesture natively. Android's ScrollView
// ignores those props, so on Android the image renders fit-to-screen
// without pinch (still big-and-readable, still tap-to-dismiss). A
// real Android zoom would need react-native-gesture-handler's
// PinchGestureHandler + Reanimated; deferred since fit-to-screen
// covers 95% of "I just want to see this clearly" cases.

type Props = {
  uri: string | null;
  onClose: () => void;
};

export function ImageLightbox({ uri, onClose }: Props) {
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const visible = !!uri;

  return (
    <Modal
      visible={visible}
      transparent
      // Native fade for both open + close. A JS-driven fade-out
      // couldn't run because Modal unmounts the instant `visible`
      // flips false — the fade-out animation never got a chance.
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <ScrollView
          // iOS only — Android ignores these, but the layout below
          // still produces a fit-to-screen image so the user can
          // see the whole thing.
          minimumZoomScale={1}
          maximumZoomScale={Platform.OS === 'ios' ? 4 : 1}
          // flexGrow (not flex) on the content container lets the
          // ScrollView grow past the viewport when the user pinches
          // to zoom; flex: 1 would lock content to viewport size and
          // break panning at zoom > 1.
          contentContainerStyle={{
            flexGrow: 1,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          style={{ flex: 1 }}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Pressable
            onPress={onClose}
            // Tap anywhere to dismiss. The image fills the window
            // (resizeMode="contain" letterboxes it), so there's no
            // exposed backdrop to tap around it — wrapping the image in
            // its own tap-swallowing Pressable would therefore cover the
            // whole screen and make the lightbox impossible to close by
            // tapping. Letting taps bubble up to this handler gives the
            // expected tap-to-close behavior. Pinch-zoom and panning are
            // drag gestures, not taps, so they don't trigger onPress.
            style={{ width: winWidth, height: winHeight, alignItems: 'center', justifyContent: 'center' }}
          >
            {uri ? (
              <Image
                source={{ uri }}
                // Fit to window without cropping: contain keeps the
                // full aspect ratio in view regardless of source size.
                style={{ width: winWidth, height: winHeight }}
                resizeMode="contain"
                accessibilityLabel="Attachment image"
              />
            ) : (
              <View />
            )}
          </Pressable>
        </ScrollView>

        {/* Close button absolutely positioned over the scroll view —
            putting it inside a SafeAreaView with edges=['top'] keeps
            it clear of the notch / dynamic island without shrinking
            the ScrollView's height (which would have left the
            full-screen Pressable child taller than its container and
            produced unwanted vertical scroll at zoom = 1).
            style.pointerEvents='box-none' lets pinch/scroll on the
            ScrollView pass through the SafeAreaView's empty space. */}
        <SafeAreaView
          // pointerEvents lives on style now (the deprecated prop form
          // emits a LogBox warning on RN 0.81+). box-none lets pinch /
          // scroll on the ScrollView pass through this view's empty
          // space — only the close-button Pressable inside catches
          // taps.
          style={{
            position: 'absolute',
            top: space(2),
            right: space(2),
            zIndex: 1,
            pointerEvents: 'box-none',
          }}
          edges={['top']}
        >
          <Pressable
            onPress={onClose}
            accessibilityLabel="Close image"
            hitSlop={12}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: 'rgba(0,0,0,0.45)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X size={20} color="#fff" strokeWidth={2} />
          </Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
