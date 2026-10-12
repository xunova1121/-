package com.xunova.jarvis;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WindowColorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
