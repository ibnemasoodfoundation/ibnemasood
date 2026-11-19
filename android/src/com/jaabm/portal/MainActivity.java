package com.jaabm.portal;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Jamia Arabia Abdullah Bin Masood portal for Android: the website in a full-screen WebView, with the extras
 * the portal needs on a phone (file uploads, PDF downloads into Downloads, printing, and outside links opening
 * in their own apps). Pages are the live website, so the app never needs an update when the portal changes.
 */
public class MainActivity extends Activity {
    private static final String START_URL = "https://www.jaabm.com/login";
    private static final String[] OWN_HOSTS = { "www.jaabm.com", "jaabm.com", "ibnemasood.vercel.app" };
    private static final int FILE_REQUEST = 1;

    private WebView web;
    private ValueCallback<Uri[]> pendingUpload;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setStatusBarColor(0xFF0F1842);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " JAABMApp/1.0");

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);

        web.addJavascriptInterface(new Bridge(this), "JAABMApp");
        web.setWebViewClient(new PortalClient(this));
        web.setWebChromeClient(new PortalChrome(this));
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> download(url, userAgent, disposition, mime));

        Uri link = getIntent() != null ? getIntent().getData() : null;
        if (state != null) web.restoreState(state);
        else web.loadUrl(isOwn(link) ? link.toString() : START_URL);
    }

    /** A portal link tapped while the app is open (for example in WhatsApp) opens that page */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri link = intent.getData();
        if (isOwn(link)) web.loadUrl(link.toString());
    }

    private static boolean isOwn(Uri uri) {
        if (uri == null || uri.getHost() == null || !"https".equals(uri.getScheme())) return false;
        for (String h : OWN_HOSTS) if (h.equalsIgnoreCase(uri.getHost())) return true;
        return false;
    }

    /** Opens a link in the app that handles it (phone, WhatsApp, email, other websites) */
    private void openOutside(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app on this phone can open this link.", Toast.LENGTH_SHORT).show();
        }
    }

    private static class PortalClient extends WebViewClient {
        private final MainActivity app;
        PortalClient(MainActivity app) { this.app = app; }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isOwn(uri)) return false; // the portal stays inside the app
            app.openOutside(uri);
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            // Only the main page matters; with no connection and no saved copy, show a friendly page with Retry
            if (!request.isForMainFrame()) return;
            String html = "<html><head><meta name='viewport' content='width=device-width, initial-scale=1'></head>"
                + "<body style='font-family:sans-serif;background:#FCFAF4;color:#1C2033;display:flex;align-items:center;justify-content:center;height:90vh;margin:0'>"
                + "<div style='text-align:center;padding:24px'><h2 style='color:#0F1842'>No internet connection</h2>"
                + "<p>Pages you opened before work offline. Connect to the internet to open this page.</p>"
                + "<button onclick=\"location.href='" + START_URL + "'\" style='background:#0F1842;color:#E3BE62;border:0;border-radius:24px;padding:12px 28px;font-size:16px'>Try again</button>"
                + "</div></body></html>";
            view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        }
    }

    private static class PortalChrome extends WebChromeClient {
        private final MainActivity app;
        PortalChrome(MainActivity app) { this.app = app; }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (app.pendingUpload != null) app.pendingUpload.onReceiveValue(null);
            app.pendingUpload = callback;
            try {
                app.startActivityForResult(Intent.createChooser(params.createIntent(), "Choose a file"), FILE_REQUEST);
            } catch (ActivityNotFoundException e) {
                app.pendingUpload = null;
                Toast.makeText(app, "No app found to choose a file.", Toast.LENGTH_SHORT).show();
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_REQUEST && pendingUpload != null) {
            pendingUpload.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            pendingUpload = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** Normal downloads (for example a backup file) go through Android's download manager, signed in */
    private void download(String url, String userAgent, String disposition, String mime) {
        if (url.startsWith("blob:") || url.startsWith("data:")) return; // PDFs come through the bridge instead
        try {
            String name = URLUtil.guessFileName(url, disposition, mime);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
            r.addRequestHeader("User-Agent", userAgent);
            r.setMimeType(mime);
            r.setTitle(name);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(r);
            Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "The download could not start.", Toast.LENGTH_SHORT).show();
        }
    }

    /** Called from the portal's pages (window.JAABMApp) for things a WebView cannot do by itself */
    private static class Bridge {
        private final MainActivity app;
        Bridge(MainActivity app) { this.app = app; }

        /** Saves a file made in the page (a PDF certificate, receipt or slip) to Downloads and opens it */
        @JavascriptInterface
        public void saveFile(String base64, String mime, String name) {
            app.runOnUiThread(() -> {
                try {
                    byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                    String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
                    Uri opened;
                    if (Build.VERSION.SDK_INT >= 29) {
                        ContentValues v = new ContentValues();
                        v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                        v.put(MediaStore.Downloads.MIME_TYPE, mime);
                        v.put(MediaStore.Downloads.IS_PENDING, 1);
                        Uri item = app.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                        try (OutputStream out = app.getContentResolver().openOutputStream(item)) { out.write(bytes); }
                        v.clear();
                        v.put(MediaStore.Downloads.IS_PENDING, 0);
                        app.getContentResolver().update(item, v, null, null);
                        opened = item;
                    } else {
                        File dir = app.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                        File f = new File(dir, safe);
                        try (FileOutputStream out = new FileOutputStream(f)) { out.write(bytes); }
                        opened = null;
                        Toast.makeText(app, "Saved: " + f.getAbsolutePath(), Toast.LENGTH_LONG).show();
                    }
                    if (opened != null) {
                        Toast.makeText(app, "Saved to Downloads: " + safe, Toast.LENGTH_SHORT).show();
                        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(opened, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        try { app.startActivity(view); } catch (ActivityNotFoundException ignored) { /* no PDF viewer: the file is in Downloads */ }
                    }
                } catch (Exception e) {
                    Toast.makeText(app, "The file could not be saved.", Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** Opens Android's print screen for the current page (also offers "Save as PDF") */
        @JavascriptInterface
        public void print(String title) {
            app.runOnUiThread(() -> {
                PrintManager pm = (PrintManager) app.getSystemService(Context.PRINT_SERVICE);
                String job = title == null || title.isEmpty() ? "JAABM document" : title;
                pm.print(job, app.web.createPrintDocumentAdapter(job), null);
            });
        }

        @JavascriptInterface
        public String version() { return "1.0"; }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush(); // stay signed in after the app is closed
    }
}
