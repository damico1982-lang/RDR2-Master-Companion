package com.frontierguide.app

import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.TextView

class CoachOverlay(private val context: Context) {
    private val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var view: TextView? = null
    private var params: WindowManager.LayoutParams? = null

    fun show(text: String) {
        if (!Settings.canDrawOverlays(context)) return
        val label = text.trim().ifEmpty { "Watching" }.take(280)
        val existing = view
        if (existing != null) {
            existing.tag = label
            if (existing.text != "Tip") existing.text = label
            return
        }
        val tip = TextView(context).apply {
            this.text = label
            tag = label
            setTextColor(0xFFF6E7C8.toInt())
            textSize = 15f
            setPadding(28, 22, 28, 22)
            setBackgroundColor(0xF21A120F.toInt())
            var downX = 0f
            var downY = 0f
            var moved = false
            setOnTouchListener { _, event ->
                val layout = params ?: return@setOnTouchListener false
                when (event.action) {
                    MotionEvent.ACTION_DOWN -> {
                        downX = event.rawX
                        downY = event.rawY
                        moved = false
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        if (kotlin.math.abs(event.rawX - downX) > 12 || kotlin.math.abs(event.rawY - downY) > 12) moved = true
                        if (moved) {
                            layout.x = event.rawX.toInt() - width / 2
                            layout.y = event.rawY.toInt() - height / 2
                            try { windowManager.updateViewLayout(this, layout) } catch (_: Exception) {}
                        }
                        true
                    }
                    MotionEvent.ACTION_UP -> {
                        if (!moved) {
                            val full = (tag as? String)?.ifBlank { "Watching" } ?: "Watching"
                            setText(if (getText().toString() == "Tip") full else "Tip")
                        }
                        true
                    }
                    else -> false
                }
            }
        }
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        val layout = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 24
            y = 120
        }
        params = layout
        view = tip
        try {
            windowManager.addView(tip, layout)
        } catch (_: Exception) {
            view = null
            params = null
        }
    }

    fun hide() {
        val tip = view ?: return
        try { windowManager.removeView(tip) } catch (_: Exception) {}
        view = null
        params = null
    }
}
