package com.zhijian.reader;

import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PageKeysPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * 音量键翻页：只在阅读器打开时（PageKeysPlugin.enabled）消费，
     * 其余时候原样交给系统调音量。
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        boolean isVolume = code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN;
        if (isVolume && PageKeysPlugin.isEnabled()) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0 && bridge != null && bridge.getWebView() != null) {
                String dir = code == KeyEvent.KEYCODE_VOLUME_UP ? "prev" : "next";
                bridge.getWebView().evaluateJavascript(
                    "(function(){try{return !!(window.__zjPageKey&&window.__zjPageKey('" + dir + "'))}catch(e){return false}})()",
                    null
                );
            }
            // ACTION_UP 也吞掉，避免系统在抬起时补一次音量调整
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}
