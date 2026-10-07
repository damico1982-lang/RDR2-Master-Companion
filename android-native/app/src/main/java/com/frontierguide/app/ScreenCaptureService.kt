package com.frontierguide.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream

class ScreenCaptureService : Service() {
    private var projection: MediaProjection? = null
    private var reader: ImageReader? = null
    private var display: VirtualDisplay? = null
    private var lastWrite = 0L
    private var sessionId = 0
    private var frameId = 0
    private var announced = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private var encodeThread: HandlerThread? = null
    private var encodeHandler: Handler? = null

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            stopSelf()
        }

        override fun onCapturedContentResize(width: Int, height: Int) {
            if (width > 1 && height > 1) mainHandler.post { openDisplay(width, height) }
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(77, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(77, buildNotification())
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val code = intent?.getIntExtra("resultCode", 0) ?: 0
        val data = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra("data", Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra("data")
        }
        val session = intent?.getIntExtra("session", 0) ?: 0
        if (code == 0 || data == null || session == 0 || session != acceptSession) {
            publish("denied", "Screen share was not allowed.")
            stopSelf()
            return START_NOT_STICKY
        }

        stopCaptureOnly()
        sessionId = session
        frameId = 0
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        try {
            projection = mgr.getMediaProjection(code, data)
        } catch (_: Exception) {
            projection = null
        }
        if (projection == null) {
            publish("denied", "Android did not start screen share.")
            stopSelf()
            return START_NOT_STICKY
        }
        projection?.registerCallback(projectionCallback, mainHandler)
        val metrics = resources.displayMetrics
        val width = 720
        val height = (width * metrics.heightPixels.toFloat() / metrics.widthPixels.coerceAtLeast(1).toFloat()).toInt().coerceIn(480, 1600)
        openDisplay(width, height)
        active = true
        currentSession = sessionId
        announced = true
        publish("ready", null)
        return START_NOT_STICKY
    }

    private fun openDisplay(width: Int, height: Int) {
        val targetWidth = width.coerceIn(320, 1280)
        val targetHeight = height.coerceIn(320, 1600)
        reader?.setOnImageAvailableListener(null, null)
        reader?.close()
        display?.release()
        encodeThread?.quitSafely()
        val thread = HandlerThread("fg-capture")
        thread.start()
        encodeThread = thread
        encodeHandler = Handler(thread.looper)
        val nextReader = ImageReader.newInstance(targetWidth, targetHeight, PixelFormat.RGBA_8888, 2)
        reader = nextReader
        val metrics = resources.displayMetrics
        display = projection?.createVirtualDisplay(
            "FrontierGuideCapture",
            targetWidth,
            targetHeight,
            metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            nextReader.surface,
            null,
            encodeHandler
        )
        nextReader.setOnImageAvailableListener({ imageReader ->
            var image: android.media.Image? = null
            try {
                if (System.currentTimeMillis() - lastWrite < 1400) {
                    imageReader.acquireLatestImage()?.close()
                    return@setOnImageAvailableListener
                }
                val frame = imageReader.acquireLatestImage() ?: return@setOnImageAvailableListener
                image = frame
                val plane = frame.planes[0]
                val pixelStride = plane.pixelStride.coerceAtLeast(1)
                val rowPadding = plane.rowStride - pixelStride * targetWidth
                val bitmapWidth = targetWidth + (rowPadding / pixelStride).coerceAtLeast(0)
                val bitmap = Bitmap.createBitmap(bitmapWidth, targetHeight, Bitmap.Config.ARGB_8888)
                bitmap.copyPixelsFromBuffer(plane.buffer)
                frame.close()
                image = null
                val cropped = if (bitmapWidth == targetWidth) bitmap else Bitmap.createBitmap(bitmap, 0, 0, targetWidth, targetHeight)
                val bytes = ByteArrayOutputStream()
                cropped.compress(Bitmap.CompressFormat.JPEG, 82, bytes)
                if (cropped !== bitmap) cropped.recycle()
                bitmap.recycle()
                publishFrame(bytes.toByteArray(), targetWidth, targetHeight)
                lastWrite = System.currentTimeMillis()
            } catch (_: Exception) {
                // A bad frame must not take down the process.
            } finally {
                image?.close()
            }
        }, encodeHandler)
    }

    private fun publishFrame(jpeg: ByteArray, width: Int, height: Int) {
        frameId += 1
        val tmp = File(cacheDir, "latest_screen.jpg.tmp")
        val dest = File(cacheDir, "latest_screen.jpg")
        FileOutputStream(tmp).use { it.write(jpeg) }
        if (!tmp.renameTo(dest)) {
            dest.writeBytes(jpeg)
            tmp.delete()
        }
        File(cacheDir, "latest_screen.json").writeText(
            """{"state":"sharing","session":$sessionId,"frame":$frameId,"time":${System.currentTimeMillis()},"width":$width,"height":$height}"""
        )
    }

    private fun publish(state: String, message: String?) {
        val intent = Intent(ACTION_EVENT).setPackage(packageName).putExtra("state", state).putExtra("session", sessionId)
        if (message != null) intent.putExtra("message", message)
        sendBroadcast(intent)
    }

    private fun clearFrames() {
        File(cacheDir, "latest_screen.jpg").delete()
        File(cacheDir, "latest_screen.jpg.tmp").delete()
        File(cacheDir, "latest_screen.json").delete()
    }

    private fun stopCaptureOnly() {
        reader?.setOnImageAvailableListener(null, null)
        reader?.close()
        reader = null
        display?.release()
        display = null
        try { projection?.unregisterCallback(projectionCallback) } catch (_: Exception) {}
        try { projection?.stop() } catch (_: Exception) {}
        projection = null
        encodeThread?.quitSafely()
        encodeThread = null
        encodeHandler = null
    }

    override fun onDestroy() {
        stopCaptureOnly()
        active = false
        currentSession = 0
        clearFrames()
        if (announced) publish("stopped", null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, ScreenCaptureService::class.java).setAction(ACTION_STOP)
        val stop = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL)
            .setContentTitle("Frontier Guide screen share")
            .setContentText("Keeping the latest game frame ready")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop sharing", stop)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL, "Screen capture", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    companion object {
        const val ACTION_EVENT = "com.frontierguide.app.CAPTURE_EVENT"
        const val ACTION_STOP = "com.frontierguide.app.CAPTURE_STOP"
        private const val CHANNEL = "fg_capture"
        @Volatile var active: Boolean = false
        @Volatile var currentSession: Int = 0
        @Volatile var acceptSession: Int = 0
        private var sessionCounter = 0
        fun takeSession(): Int = synchronized(this) { ++sessionCounter }
    }
}
