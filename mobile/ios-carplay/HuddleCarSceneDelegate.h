//
//  HuddleCarSceneDelegate.h
//  Huddle
//
//  CarPlay template scene delegate. iOS instantiates this class for the CarPlay
//  scene declared in Info.plist (UIApplicationSceneManifest →
//  CPTemplateApplicationSceneSessionRoleApplication). It hands the CarPlay
//  interface controller + window to react-native-carplay's RNCarPlay bridge,
//  which is what the JS side (src/lib/carplay.ts) drives.
//
//  This file is copied into ios/<project>/ by plugins/withCarPlay.js during
//  `expo prebuild` — do not edit the generated copy; edit this source of truth.
//

#import <UIKit/UIKit.h>
#import <CarPlay/CarPlay.h>

@interface HuddleCarSceneDelegate : UIResponder <CPTemplateApplicationSceneDelegate>

@end
