package com.frontierguide.app

import android.app.*
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
import android.os.IBinder
import android.os.Looper
import java.io.File
import java.io.FileOutputStream

class ScreenCaptureService : Service() {
    private var projection: MediaProjection? = null
    private var reader: ImageReader? = null
    private var display: VirtualDisplay? = null
    private var lastWrite = 0L
    private val mainHandler = Handler(Looper.getMainLooper())

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            stopSelf()
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        val notification = Notification.Builder(this, "fg_capture")
            .setContentTitle("Frontier Guide screen share")
            .setContentText("Keeping the latest game frame ready for your questions")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(77, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(77, notification)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val code = intent?.getIntExtra("resultCode", 0) ?: 0
        val data = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra("data", Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra("data")
        }
        if (code == 0 || data == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        stopCaptureOnly()
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        try {
            projection = mgr.getMediaProjection(code, data)
        } catch (_: Exception) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (projection == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        projection?.registerCallback(projectionCallback, mainHandler)

        val dm = resources.displayMetrics
        val width = 720
        val height = (width * dm.heightPixels.toFloat() / dm.widthPixels.coerceAtLeast(1).toFloat()).toInt().coerceAtLeast(480)
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        display = projection?.createVirtualDisplay(
            "FrontierGuideCapture",
            width,
            height,
            dm.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader?.surface,
            null,
            null
        )

        reader?.setOnImageAvailableListener({ r ->
            var image: android.media.Image? = null
            try {
                if (System.currentTimeMillis() - lastWrite < 1400) {
                    r.acquireLatestImage()?.close()
                    return@setOnImageAvailableListener
                }
                val frame = r.acquireLatestImage() ?: return@setOnImageAvailableListener
                image = frame
                val plane = frame.planes[0]
                val pixelStride = plane.pixelStride.coerceAtLeast(1)
                val rowPadding = plane.rowStride - pixelStride * width
                val bitmapWidth = width + (rowPadding / pixelStride).coerceAtLeast(0)
                val bmp = Bitmap.createBitmap(bitmapWidth, height, Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(plane.buffer)
                val cropped = if (bitmapWidth == width) bmp else Bitmap.createBitmap(bmp, 0, 0, width, height)
                FileOutputStream(File(cacheDir, "latest_screen.jpg")).use {
                    cropped.compress(Bitmap.CompressFormat.JPEG, 84, it)
                }
                if (cropped !== bmp) cropped.recycle()
                bmp.recycle()
                lastWrite = System.currentTimeMillis()
            } catch (_: Exception) {
                // A bad frame must not take down the process.
            } finally {
                image?.close()
            }
        }, mainHandler)
        return START_NOT_STICKY
    }

    private fun stopCaptureOnly() {
        reader?.setOnImageAvailableListener(null, null)
        reader?.close()
        reader = null
        display?.release()
        display = null
        projection?.unregisterCallback(projectionCallback)
        projection?.stop()
        projection = null
    }

    override fun onDestroy() {
        stopCaptureOnly()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(
                "fg_capture",
                "Screen capture",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}
