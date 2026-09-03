import { Capacitor } from '@capacitor/core';
import { NativeProvider } from './provider.native';
import { WebProvider } from './provider.web';
import { DesktopProvider } from './provider.desktop';
import { isDesktopRuntime } from './desktop.runtime';
export function createLlmProvider() {
    if (isDesktopRuntime()) {
        return new DesktopProvider();
    }
    const platform = Capacitor.getPlatform();
    if (platform === 'ios' || platform === 'android') {
        return new NativeProvider();
    }
    return new WebProvider();
}
//# sourceMappingURL=provider.factory.js.map