package net.shareat.pos2;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Cashier birthday song. Plays the bundled MP3s with Android's MediaPlayer, looping
 * through the playlist until stop(). The WebView's own <audio> stopped responding after
 * a stop on the tablets (2026-10-17), so on Android playback lives here; the web side
 * only keeps state. Holds media audio focus while playing so other music apps pause.
 *
 * Events: "track" with { index } — the playing track, or -1 once stopped.
 */
@CapacitorPlugin(name = "BirthdaySong")
public class BirthdaySongPlugin extends Plugin {
    private static final String TAG = "BirthdaySong";
    /** Same order as PLAYLIST in src/lib/birthday/player.ts. Bundled under assets/public. */
    private static final String[] FILES = { "public/sounds/birthday-shareat.mp3", "public/sounds/happy-birthday.mp3" };

    private final Handler main = new Handler(Looper.getMainLooper());
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest; // API 26+
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        // Another app took the speaker for good (e.g. a call): stop, so we don't fight it.
        if (change == AudioManager.AUDIOFOCUS_LOSS) main.post(() -> stopPlayback(true));
    };

    private MediaPlayer player;
    private int index = -1;
    /** Consecutive tracks that failed to play; stops instead of skipping forever. */
    private int failures = 0;

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    /** Starts the loop at track `start`. Resolves once the first track is playing. */
    @PluginMethod
    public void play(PluginCall call) {
        int start = call.getInt("start", 0);
        main.post(() -> {
            stopPlayback(false);
            requestFocus();
            failures = 0;
            if (playIndex(Math.floorMod(start, FILES.length))) {
                call.resolve();
            } else {
                stopPlayback(true);
                call.reject("The song file could not be played.");
            }
        });
    }

    /** Stops playback. Resolves with { track, fraction } of where it stopped (track -1 if idle). */
    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            JSObject ret = new JSObject();
            ret.put("track", index);
            ret.put("fraction", fraction());
            stopPlayback(true);
            call.resolve(ret);
        });
    }

    private double fraction() {
        try {
            if (player != null && player.getDuration() > 0) {
                return (double) player.getCurrentPosition() / player.getDuration();
            }
        } catch (IllegalStateException ignored) { }
        return 0;
    }

    private boolean playIndex(int i) {
        releasePlayer();
        MediaPlayer mp = new MediaPlayer();
        try {
            mp.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build());
            setSource(mp, FILES[i]);
            mp.setOnCompletionListener(m -> playNext());
            mp.setOnErrorListener((m, what, extra) -> {
                Log.w(TAG, "playback error " + what + "/" + extra + " on " + FILES[index]);
                playNext();
                return true;
            });
            mp.prepare();
            mp.start();
        } catch (Exception e) {
            Log.w(TAG, "could not play " + FILES[i], e);
            mp.release();
            index = -1;
            return false;
        }
        player = mp;
        index = i;
        notifyTrack(i);
        return true;
    }

    /** Advances the loop; a file that fails is skipped, but two failures in a row stop it. */
    private void playNext() {
        if (index < 0) return;
        int next = (index + 1) % FILES.length;
        if (playIndex(next)) {
            failures = 0;
        } else if (++failures >= FILES.length) {
            stopPlayback(true);
        } else {
            index = next;
            playNext();
        }
    }

    /** Opens the asset directly; falls back to a cache copy if the APK stored it compressed. */
    private void setSource(MediaPlayer mp, String asset) throws Exception {
        try (AssetFileDescriptor afd = getContext().getAssets().openFd(asset)) {
            mp.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            return;
        } catch (java.io.FileNotFoundException compressed) {
            // openFd only works for uncompressed assets.
        }
        File out = new File(getContext().getCacheDir(), asset.replace('/', '_'));
        if (!out.exists()) {
            try (InputStream in = getContext().getAssets().open(asset); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
        }
        mp.setDataSource(out.getAbsolutePath());
    }

    private void stopPlayback(boolean notify) {
        boolean wasPlaying = index >= 0;
        releasePlayer();
        index = -1;
        abandonFocus();
        if (notify && wasPlaying) notifyTrack(-1);
    }

    private void releasePlayer() {
        if (player == null) return;
        try { player.stop(); } catch (IllegalStateException ignored) { }
        player.release();
        player = null;
    }

    private void notifyTrack(int i) {
        JSObject data = new JSObject();
        data.put("index", i);
        notifyListeners("track", data);
    }

    private void requestFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build())
                .setOnAudioFocusChangeListener(focusListener)
                .build();
            audioManager.requestAudioFocus(focusRequest);
        } else {
            audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
    }

    private void abandonFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
            focusRequest = null;
        } else {
            audioManager.abandonAudioFocus(focusListener);
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopPlayback(false);
    }
}
