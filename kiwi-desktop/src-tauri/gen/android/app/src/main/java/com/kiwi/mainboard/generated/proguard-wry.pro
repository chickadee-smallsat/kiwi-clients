# THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!!

# Copyright 2020-2023 Tauri Programme within The Commons Conservancy
# SPDX-License-Identifier: Apache-2.0
# SPDX-License-Identifier: MIT

-keep class com.kiwi.mainboard.* {
  native <methods>;
}

-keep class com.kiwi.mainboard.WryActivity {
  public <init>(...);

  void setWebView(com.kiwi.mainboard.RustWebView);
  java.lang.Class getAppClass(...);
  java.lang.String getVersion();
}

-keep class com.kiwi.mainboard.Ipc {
  public <init>(...);

  @android.webkit.JavascriptInterface public <methods>;
}

-keep class com.kiwi.mainboard.RustWebView {
  public <init>(...);

  void loadUrlMainThread(...);
  void loadHTMLMainThread(...);
  void evalScript(...);
}

-keep class com.kiwi.mainboard.RustWebChromeClient,com.kiwi.mainboard.RustWebViewClient {
  public <init>(...);
}
