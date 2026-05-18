package com.diexar.keepcapture

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import java.io.File

/**
 * Eenvoudige wrapper rond MediaRecorder voor voicememo-opname (.m4a).
 * Levensduur: één opname per instance. Gebruik [start] om te beginnen,
 * [stopAndFinalize] om af te ronden. Bij annulering: [discard].
 *
 * Container: MP4 / AAC mono, 64kbps. Opnamen vallen rond ~480kB/min.
 */
class VoiceMemoRecorder(private val context: Context) {

    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var startElapsedMs: Long = 0L

    /**
     * Start de opname. Levert een [Result.failure] als MediaRecorder weigert
     * te starten (geen mic-permissie, geen mic-hardware, andere app blokkeert).
     */
    fun start(): Result<Unit> {
        if (recorder != null) {
            return Result.failure(IllegalStateException("Opname loopt al."))
        }
        val target = File(context.cacheDir, "voicememo-${System.currentTimeMillis()}.m4a")
        @Suppress("DEPRECATION")
        val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            MediaRecorder()
        }
        return try {
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioEncodingBitRate(64_000)
            rec.setAudioSamplingRate(44_100)
            rec.setAudioChannels(1)
            rec.setOutputFile(target.absolutePath)
            rec.prepare()
            rec.start()
            recorder = rec
            outputFile = target
            startElapsedMs = SystemClock.elapsedRealtime()
            Result.success(Unit)
        } catch (e: Exception) {
            try { rec.release() } catch (_: Exception) {}
            target.delete()
            Result.failure(e)
        }
    }

    /**
     * Stopt de opname en retourneert het bestand + duur in milliseconden.
     * Bij failure: het temp-bestand is opgeruimd.
     */
    fun stopAndFinalize(): Result<RecordedMemo> {
        val rec = recorder ?: return Result.failure(IllegalStateException("Geen actieve opname."))
        val file = outputFile ?: return Result.failure(IllegalStateException("Geen output-bestand."))
        val durationMs = SystemClock.elapsedRealtime() - startElapsedMs
        return try {
            rec.stop()
            rec.release()
            recorder = null
            outputFile = null
            if (!file.exists() || file.length() == 0L) {
                file.delete()
                Result.failure(IllegalStateException("Lege opname."))
            } else {
                Result.success(RecordedMemo(file, durationMs))
            }
        } catch (e: Exception) {
            // MediaRecorder.stop() gooit als < 1 seconde opgenomen; ruim op.
            try { rec.release() } catch (_: Exception) {}
            recorder = null
            outputFile = null
            file.delete()
            Result.failure(e)
        }
    }

    /**
     * Gooit een lopende opname weg zonder verder te verwerken. Veilig om aan
     * te roepen vanuit lifecycle-callbacks of error-paths.
     */
    fun discard() {
        val rec = recorder
        val file = outputFile
        recorder = null
        outputFile = null
        if (rec != null) {
            try { rec.stop() } catch (_: Exception) {}
            try { rec.release() } catch (_: Exception) {}
        }
        file?.delete()
    }

    /** Verstreken tijd sinds [start], in milliseconden. Returnt 0 als niet actief. */
    fun elapsedMs(): Long {
        if (recorder == null) return 0L
        return SystemClock.elapsedRealtime() - startElapsedMs
    }

    data class RecordedMemo(val file: File, val durationMs: Long)
}
