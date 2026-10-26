package com.zhijian.reader;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 硬件翻页键桥。
 *
 * 墨水屏设备（BOOX / 汉王 / 掌阅等）侧面的实体键常复用音量键，
 * 而音量键在 Android 上会被系统音频服务消费，WebView 的 keydown 收不到。
 * 所以在 Activity 的 dispatchKeyEvent 里拦下，再按这里的开关决定是否当作翻页键：
 * 只有阅读器打开时才启用，平时音量键仍然是音量键。
 */
@CapacitorPlugin(name = "PageKeys")
public class PageKeysPlugin extends Plugin {

    private static volatile boolean enabled = false;

    static boolean isEnabled() {
        return enabled;
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        call.resolve();
    }

    @PluginMethod
    public void getEnabled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }
}
