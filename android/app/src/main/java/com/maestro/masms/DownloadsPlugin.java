package com.maestro.masms;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Saves a file straight into the phone's public Downloads folder, then (on request)
 * offers Android's "Open with" chooser for it. Used for every PDF / Excel download.
 */
@CapacitorPlugin(
    name = "Downloads",
    permissions = {
        @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "storage")
    }
)
public class DownloadsPlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        // Android 10+ writes through MediaStore and needs no permission; 9 and below need storage access.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermsCallback");
            return;
        }
        doSave(call);
    }

    @PermissionCallback
    private void storagePermsCallback(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) {
            doSave(call);
        } else {
            call.reject("Storage permission was denied");
        }
    }

    private void doSave(PluginCall call) {
        String name = call.getString("name", "MASMS-file");
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data");
        if (data == null) {
            call.reject("No data to save");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            Context ctx = getContext();
            Uri uri;
            String savedName = name;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = ctx.getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, mime);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    call.reject("Could not create the file in Downloads");
                    return;
                }
                try (OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) {
                        call.reject("Could not open the file in Downloads");
                        return;
                    }
                    out.write(bytes);
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(uri, done, null, null);
                try (Cursor c = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                    if (c != null && c.moveToFirst()) savedName = c.getString(0);
                }
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                File file = new File(dir, name);
                int n = 1;
                String base = name, ext = "";
                int dot = name.lastIndexOf('.');
                if (dot > 0) {
                    base = name.substring(0, dot);
                    ext = name.substring(dot);
                }
                while (file.exists()) {
                    file = new File(dir, base + " (" + (n++) + ")" + ext);
                }
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                savedName = file.getName();
                MediaScannerConnection.scanFile(ctx, new String[] { file.getAbsolutePath() }, new String[] { mime }, null);
                uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
            }
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            ret.put("name", savedName);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not save the file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String uri = call.getString("uri");
        String mime = call.getString("mime", "*/*");
        if (uri == null) {
            call.reject("No file to open");
            return;
        }
        try {
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(Uri.parse(uri), mime);
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(view, "Open with");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app found to open this file");
        }
    }
}
