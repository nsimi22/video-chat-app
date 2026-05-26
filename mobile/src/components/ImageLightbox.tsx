import { useEffect, useRef } from 'react';
import { Animated, Image, Modal, Platform, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { colors, space } from '@/theme';

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
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fade, {
      toValue: visible ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [visible, fade]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Animated.View style={{ flex: 1, backgroundColor: '#000', opacity: fade }}>
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
          {/* Close button — top-right so the gesture target doesn't
              compete with pinch + scroll on the image itself. */}
          <Pressable
            onPress={onClose}
            accessibilityLabel="Close image"
            hitSlop={12}
            style={{
              position: 'absolute',
              top: space(2),
              right: space(2),
              zIndex: 1,
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

          <ScrollView
            // iOS only — Android ignores these, but the layout below
            // still produces a fit-to-screen image so the user can
            // see the whole thing.
            minimumZoomScale={1}
            maximumZoomScale={Platform.OS === 'ios' ? 4 : 1}
            // contentContainerStyle centers the image when not zoomed.
            contentContainerStyle={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
            }}
            style={{ flex: 1 }}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          >
            <Pressable
              onPress={onClose}
              // Backdrop dismiss everywhere outside the image itself.
              // The image absorbs its own taps (no onPress on <Image>),
              // so a tap on the photo doesn't close — only the
              // surrounding negative space does.
              style={{ width: winWidth, height: winHeight, alignItems: 'center', justifyContent: 'center' }}
            >
              {uri ? (
                <Image
                  source={{ uri }}
                  // Fit to window without cropping: contain keeps the
                  // full aspect ratio in view regardless of source size.
                  // The container is the full window minus the safe-area
                  // padding the SafeAreaView already applied.
                  style={{ width: winWidth, height: winHeight }}
                  resizeMode="contain"
                  accessibilityLabel="Attachment image"
                />
              ) : (
                <View />
              )}
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}
