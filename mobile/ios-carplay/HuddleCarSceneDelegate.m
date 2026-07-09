//
//  HuddleCarSceneDelegate.m
//  Huddle
//
//  See HuddleCarSceneDelegate.h. Written in Objective-C (not Swift) on purpose:
//  react-native-carplay ships ObjC headers, so importing RNCarPlay here avoids
//  the Swift bridging-header setup a .swift delegate would need in a prebuilt
//  Expo project.
//

#import "HuddleCarSceneDelegate.h"

// react-native-carplay exposes the RNCarPlay bridge class. The umbrella import
// works whether CocoaPods integrates the pod as a static lib or a framework.
#if __has_include(<react_native_carplay/RNCarPlay.h>)
#import <react_native_carplay/RNCarPlay.h>
#elif __has_include(<react-native-carplay/RNCarPlay.h>)
#import <react-native-carplay/RNCarPlay.h>
#else
#import "RNCarPlay.h"
#endif

@implementation HuddleCarSceneDelegate

- (void)templateApplicationScene:(CPTemplateApplicationScene *)templateApplicationScene
       didConnectInterfaceController:(CPInterfaceController *)interfaceController
                          toWindow:(CPWindow *)window {
  [RNCarPlay connectWithInterfaceController:interfaceController window:window];
}

- (void)templateApplicationScene:(CPTemplateApplicationScene *)templateApplicationScene
    didDisconnectInterfaceController:(CPInterfaceController *)interfaceController
                        fromWindow:(CPWindow *)window {
  [RNCarPlay disconnect];
}

@end
