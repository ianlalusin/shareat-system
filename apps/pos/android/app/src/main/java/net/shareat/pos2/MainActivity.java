package net.shareat.pos2;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ThermalPrinterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
