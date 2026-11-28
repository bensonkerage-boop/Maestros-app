package com.maestro.masms;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DownloadsPlugin.class);
        super.onCreate(savedInstanceState);
        // Fixed 100% text size so the app looks the same as the website on every phone, whatever its system font-size setting.
        try { getBridge().getWebView().getSettings().setTextZoom(100); } catch (Exception ignored) {}
    }
}
