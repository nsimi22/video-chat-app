//
//  AppDelegate+HuddleCarPlay.m
//  Huddle
//
//  CarPlay connection via the AppDelegate `CPApplicationDelegate` path — the
//  method react-native-carplay documents. We deliberately DON'T convert the app
//  to UIScene (no UIApplicationSceneManifest / UIApplicationSupportsMultipleScenes):
//  in a prebuilt Expo SDK 54 / RN 0.81 app, enabling multiple scenes without a
//  matching UIWindowScene delegate leaves the phone's AppDelegate-created window
//  unattached and the whole app renders black. Keeping the app AppDelegate/window
//  based avoids that entirely; CarPlay attaches through the CPWindow below.
//
//  Written as an Objective-C category on the Swift AppDelegate (imported via the
//  generated "<Module>-Swift.h") so we can use react-native-carplay's ObjC
//  RNCarPlay header directly, with no Swift bridging-header setup.
//

#import <CarPlay/CarPlay.h>
#import "Huddle-Swift.h"

// react-native-carplay exposes the RNCarPlay bridge class. The umbrella import
// works whether CocoaPods integrates the pod as a static lib or a framework.
#if __has_include(<react_native_carplay/RNCarPlay.h>)
#import <react_native_carplay/RNCarPlay.h>
#elif __has_include(<react-native-carplay/RNCarPlay.h>)
#import <react-native-carplay/RNCarPlay.h>
#else
#import "RNCarPlay.h"
#endif

@interface AppDelegate (HuddleCarPlay) <CPApplicationDelegate>
@end

@implementation AppDelegate (HuddleCarPlay)

- (void)application:(UIApplication *)application
    didConnectCarInterfaceController:(CPInterfaceController *)interfaceController
                            toWindow:(CPWindow *)window {
  [RNCarPlay connectWithInterfaceController:interfaceController window:window];
}

- (void)application:(UIApplication *)application
    didDisconnectCarInterfaceController:(CPInterfaceController *)interfaceController
                              fromWindow:(CPWindow *)window {
  [RNCarPlay disconnect];
}

@end
