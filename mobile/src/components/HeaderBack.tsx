import { useCallback } from 'react';
import { Keyboard, TouchableOpacity } from 'react-native';
import { router, type Href } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { colors, space } from '@/theme';

// Explicit headerLeft back chevron for pushed stack screens. On iOS 26 the
// default native-stack back button renders (and even shows its glass press
// highlight) but often doesn't pop — the user has to tap it repeatedly, or it
// never fires at all. Driving the pop from JS ourselves, with a canGoBack()
// fallback so it can never be a dead no-op (e.g. deep-linked straight to the
// screen from a push notification), guarantees a working way out. Swipe-back
// is unaffected — it's handled by the native stack independently of
// headerLeft.
export function HeaderBack({ fallback }: { fallback: Href }) {
  const goBack = useCallback(() => {
    Keyboard.dismiss();
    if (router.canGoBack()) router.back();
    else router.replace(fallback);
  }, [fallback]);
  return (
    <TouchableOpacity
      onPress={goBack}
      hitSlop={16}
      style={{ paddingRight: space(3) }}
      accessibilityLabel="Back"
      accessibilityRole="button"
    >
      <ChevronLeft size={26} color={colors.text} />
    </TouchableOpacity>
  );
}
