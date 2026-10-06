package com.frontierguide.app

import android.Manifest
import android.app.Activity
import android.content.*
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Base64
import android.util.Log
import android.view.ViewGroup
import android.webkit.*
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.util.Locale
import org.json.JSONObject

class MainActivity: AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var loader: WebViewAssetLoader
    private lateinit var projectionManager: MediaProjectionManager
    private val captureCode=9001
    private val voiceCode=9002
    private val fileChooserCode=9003
    private val micCode=45
    private val cameraCode=46
    private val notificationCode=47
    private var fileChooserCallback:ValueCallback<Array<Uri>>?=null
    private var speech: TextToSpeech?=null
    private var speechReady=false
    private var speechGen=0
    private var recognizer: SpeechRecognizer?=null
    private var voiceGen=0
    private var pendingVoiceGen: Int?=null
    private var intentVoiceGen=0
    private var pendingCaptureSession=0
    private var rendererReloads=0
    private val coachOverlay by lazy { CoachOverlay(this) }
    private val captureReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.getStringExtra("state")) {
                "ready" -> tellJs("onScreenShareReady", intent.getIntExtra("session", 0).toString())
                "denied" -> tellJs("onScreenShareDenied", intent.getStringExtra("message") ?: "Screen share was not allowed.")
                "stopped" -> tellJs("onScreenShareStopped")
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        projectionManager=getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        loader=WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        ContextCompat.registerReceiver(this, captureReceiver, IntentFilter(ScreenCaptureService.ACTION_EVENT), ContextCompat.RECEIVER_NOT_EXPORTED)
        createWebView()
        speech=TextToSpeech(this){status->
            speechReady=status==TextToSpeech.SUCCESS
            if(speechReady){
                try {
                    speech?.language=Locale.US
                    speech?.let { engine -> chooseDeepMaleVoice(engine)?.let { engine.voice = it } }
                    speech?.setPitch(0.78f)
                    speech?.setOnUtteranceProgressListener(object:UtteranceProgressListener(){
                        override fun onStart(utteranceId:String?){}
                        override fun onError(utteranceId:String?){ notifySpeechFinished(utteranceId) }
                        override fun onDone(utteranceId:String?){ notifySpeechFinished(utteranceId) }
                    })
                } catch (error: RuntimeException) {
                    Log.e(TAG, "Voice setup failed", error)
                    speechReady=false
                }
            }
        }
        web.loadUrl(START_URL)
    }

    private fun createWebView() {
        val previous = if (::web.isInitialized) web else null
        val next = WebView(this)
        next.setBackgroundColor(Color.parseColor("#130B0B"))
        next.settings.javaScriptEnabled=true
        next.settings.domStorageEnabled=true
        next.settings.mediaPlaybackRequiresUserGesture=false
        next.settings.allowFileAccess=false
        next.settings.allowContentAccess=true
        next.settings.javaScriptCanOpenWindowsAutomatically=false
        next.settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
        // Safe Browsing looks up appassets.androidplatform.net, which is not a public site.
        // That lookup blocks or crashes the local asset page on some WebView builds.
        next.settings.safeBrowsingEnabled=false
        next.webViewClient=AssetClient()
        next.webChromeClient=GuideChrome()
        next.isFocusable = true
        next.isFocusableInTouchMode = true
        next.addJavascriptInterface(Bridge(),"AndroidBridge")
        web=next
        setContentView(web)
        if (previous != null && previous !== next) {
            (previous.parent as? ViewGroup)?.removeView(previous)
            previous.destroy()
        }
    }

    private inner class AssetClient: WebViewClient() {
        override fun shouldInterceptRequest(view:WebView?, request:WebResourceRequest?): WebResourceResponse? {
            val uri=request?.url ?: return null
            if (uri.scheme=="https" && uri.host=="appassets.androidplatform.net") {
                return loader.shouldInterceptRequest(uri)
            }
            return null
        }
        override fun shouldOverrideUrlLoading(view:WebView?, request:WebResourceRequest?):Boolean {
            val uri=request?.url ?: return false
            if(uri.scheme=="https" && uri.host=="appassets.androidplatform.net")return false
            return try {
                startActivity(Intent(Intent.ACTION_VIEW,uri))
                true
            } catch(_:ActivityNotFoundException) {
                Toast.makeText(this@MainActivity,"No app can open this link",Toast.LENGTH_SHORT).show()
                true
            }
        }
        override fun onPageFinished(view: WebView?, url: String?) {
            Log.i(TAG, "page finished $url")
            view?.requestFocus()
            view?.evaluateJavascript(
                "window.frontierSetVersion && window.frontierSetVersion(${JSONObject.quote(BuildConfig.VERSION_NAME)})",
                null
            )
        }
        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
            if (request?.isForMainFrame == true) {
                Log.e(TAG, "main frame error ${error?.errorCode} ${error?.description} ${request.url}")
            }
        }
        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            Log.e(TAG, "renderer gone didCrash=${detail?.didCrash()}")
            if (rendererReloads >= 2) {
                Toast.makeText(this@MainActivity, "Frontier Guide's viewer crashed. Close the app and open it again.", Toast.LENGTH_LONG).show()
                return true
            }
            rendererReloads += 1
            createWebView()
            web.loadUrl(START_URL)
            return true
        }
    }

    private inner class GuideChrome: WebChromeClient() {
        override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
            val line = "console ${consoleMessage?.messageLevel()} ${consoleMessage?.sourceId()}:${consoleMessage?.lineNumber()} ${consoleMessage?.message()}"
            if (consoleMessage?.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.e(TAG, line) else Log.i(TAG, line)
            return true
        }
        override fun onPermissionRequest(request:PermissionRequest?){
            runOnUiThread{
                val origin=request?.origin
                val trusted=origin?.scheme=="https" && origin?.host=="appassets.androidplatform.net"
                val allowed=request?.resources?.filter{
                    it==PermissionRequest.RESOURCE_VIDEO_CAPTURE || it==PermissionRequest.RESOURCE_AUDIO_CAPTURE
                }?.toTypedArray() ?: emptyArray<String>()
                if(trusted && allowed.isNotEmpty())request?.grant(allowed) else request?.deny()
            }
        }
        override fun onShowFileChooser(webView:WebView?, callback:ValueCallback<Array<Uri>>?, params:FileChooserParams?):Boolean{
            fileChooserCallback?.onReceiveValue(null)
            fileChooserCallback=callback
            return try{
                val intent=params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply{
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type="image/*"
                }
                startActivityForResult(intent,fileChooserCode)
                true
            }catch(_:ActivityNotFoundException){
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback=null
                Toast.makeText(this@MainActivity,"No photo picker is available",Toast.LENGTH_SHORT).show()
                false
            }
        }
    }

    inner class Bridge {
        @JavascriptInterface fun hasMicrophonePermission(): Boolean = hasPermission(Manifest.permission.RECORD_AUDIO)
        @JavascriptInterface fun requestMicrophonePermission() { runOnUiThread { launchVoiceInput(null) } }
        @JavascriptInterface fun beginVoiceInput(generation: String) { runOnUiThread { launchVoiceInput(generation.toIntOrNull()) } }
        @JavascriptInterface fun cancelVoiceInput() { runOnUiThread { cancelOwnedRecognizer() } }
        @JavascriptInterface fun hasCameraPermission(): Boolean = hasPermission(Manifest.permission.CAMERA)
        @JavascriptInterface fun requestCameraPermission() {
            runOnUiThread {
                if (hasPermission(Manifest.permission.CAMERA)) tellJs("onCameraGranted")
                else askFor(Manifest.permission.CAMERA, cameraCode)
            }
        }
        @JavascriptInterface fun startScreenShare(){ runOnUiThread{ beginScreenShare() } }
        @JavascriptInterface fun stopScreenShare(){
            runOnUiThread {
                ScreenCaptureService.acceptSession = -1
                pendingCaptureSession = 0
                stopService(Intent(this@MainActivity, ScreenCaptureService::class.java))
            }
        }
        @JavascriptInterface fun getLatestScreenMeta(): String {
            if (!ScreenCaptureService.active) return """{"state":"stopped"}"""
            val file = File(cacheDir, "latest_screen.json")
            if (!file.exists()) return """{"state":"waiting","session":${ScreenCaptureService.currentSession}}"""
            return try { file.readText() } catch (_: Exception) { """{"state":"waiting"}""" }
        }
        @JavascriptInterface fun getLatestScreenDataUrl():String {
            if (!ScreenCaptureService.active) return ""
            val f=File(cacheDir,"latest_screen.jpg")
            if(!f.exists())return ""
            return try { "data:image/jpeg;base64,"+Base64.encodeToString(f.readBytes(),Base64.NO_WRAP) } catch (_: Exception) { "" }
        }
        @JavascriptInterface fun startVoiceInput(){ runOnUiThread{ launchVoiceInput(null) } }
        @JavascriptInterface fun canDrawOverlays(): Boolean = Settings.canDrawOverlays(this@MainActivity)
        @JavascriptInterface fun requestOverlayPermission() {
            runOnUiThread {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            }
        }
        @JavascriptInterface fun showCoachOverlay(text: String) { runOnUiThread { coachOverlay.show(text) } }
        @JavascriptInterface fun hideCoachOverlay() { runOnUiThread { coachOverlay.hide() } }
        @JavascriptInterface fun speak(text:String,rate:Double,pitch:Double){
            runOnUiThread{
                if(!speechReady){
                    web.evaluateJavascript("window.FrontierGuideNative?.onSpeechError('Android voice is still starting. Tap the mic again.')",null)
                    return@runOnUiThread
                }
                speechGen += 1
                val gen = speechGen
                speech?.setSpeechRate(rate.toFloat().coerceIn(.65f,1.35f))
                speech?.setPitch(pitch.toFloat().coerceIn(.7f,1.25f))
                speech?.speak(text.take(5_000),TextToSpeech.QUEUE_FLUSH,null,"frontier-$gen")
            }
        }
        @JavascriptInterface fun stopSpeaking(){ runOnUiThread{ speechGen += 1; speech?.stop() } }
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun askFor(permission: String, requestCode: Int) {
        ActivityCompat.requestPermissions(this, arrayOf(permission), requestCode)
    }

    private fun tellJs(method: String, message: String? = null) {
        if (!::web.isInitialized) return
        val call = if (message == null) "window.FrontierGuideNative?.$method()"
            else "window.FrontierGuideNative?.$method(${JSONObject.quote(message)})"
        web.evaluateJavascript(call, null)
    }

    private fun openAppSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
    }

    private fun cancelOwnedRecognizer() {
        voiceGen = -1
        pendingVoiceGen = null
        try { recognizer?.cancel() } catch (_: RuntimeException) {}
        try { recognizer?.destroy() } catch (_: RuntimeException) {}
        recognizer = null
    }

    private fun voiceIntent(): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.US.toLanguageTag())
        .putExtra(RecognizerIntent.EXTRA_PROMPT, "Ask Frontier Guide")
        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)

    private fun launchVoiceInput(fromJs: Int?) {
        if (!hasPermission(Manifest.permission.RECORD_AUDIO)) {
            pendingVoiceGen = fromJs
            askFor(Manifest.permission.RECORD_AUDIO, micCode)
            return
        }
        val gen = fromJs ?: pendingVoiceGen
        pendingVoiceGen = null
        if (gen == null) return
        voiceGen = gen
        if (SpeechRecognizer.isRecognitionAvailable(this)) startOwnedRecognizer(gen)
        else startIntentRecognizer(gen)
    }

    private fun startOwnedRecognizer(gen: Int) {
        cancelOwnedRecognizer()
        voiceGen = gen
        val engine = SpeechRecognizer.createSpeechRecognizer(this)
        recognizer = engine
        engine.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(error: Int) {
                if (gen != voiceGen) return
                tellJs("onSpeechError", speechErrorText(error))
            }
            override fun onResults(results: Bundle?) {
                if (gen != voiceGen) return
                val spoken = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                tellSpeechResult(spoken, gen)
            }
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        try {
            engine.startListening(voiceIntent())
        } catch (_: RuntimeException) {
            tellJs("onSpeechError", "Speech recognition could not start. Tap the microphone to retry.")
        }
    }

    private fun startIntentRecognizer(gen: Int) {
        intentVoiceGen = gen
        try {
            startActivityForResult(voiceIntent(), voiceCode)
        } catch (_: ActivityNotFoundException) {
            tellJs("onSpeechError", "No speech recognition service is installed on this phone.")
        }
    }

    private fun speechErrorText(code: Int) = when (code) {
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Allow microphone access, then try again."
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "I did not catch that. Tap the microphone and try again."
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition could not reach its service."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech recognition is busy. Tap the microphone again."
        else -> "Tap the microphone to retry."
    }

    private fun tellSpeechResult(text: String, gen: Int) {
        if (!::web.isInitialized) return
        web.evaluateJavascript("window.FrontierGuideNative?.onSpeechResult(${JSONObject.quote(text)}, $gen)", null)
    }

    private fun beginScreenShare() {
        if (ScreenCaptureService.active) {
            tellJs("onScreenShareReady", ScreenCaptureService.currentSession.toString())
            return
        }
        if (android.os.Build.VERSION.SDK_INT >= 33 && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
            askFor(Manifest.permission.POST_NOTIFICATIONS, notificationCode)
            return
        }
        pendingCaptureSession = ScreenCaptureService.takeSession()
        ScreenCaptureService.acceptSession = pendingCaptureSession
        startActivityForResult(projectionManager.createScreenCaptureIntent(), captureCode)
    }

    private fun permissionDenied(permission: String, retryMessage: String, blockedMessage: String) {
        val blocked = !ActivityCompat.shouldShowRequestPermissionRationale(this, permission)
        tellJs("onSpeechError", if (blocked) blockedMessage else retryMessage)
        if (blocked) openAppSettings()
    }

    private fun chooseDeepMaleVoice(engine: TextToSpeech): Voice? {
        val voices = try { engine.voices } catch (_: RuntimeException) { null } ?: return null
        fun described(voice: Voice): String {
            val features = try { voice.features?.joinToString(" ").orEmpty() } catch (_: RuntimeException) { "" }
            return (voice.name + " " + features).lowercase()
        }
        fun englishMale(voice: Voice): Boolean {
            val language = voice.locale?.language ?: return false
            if (!language.equals("en", ignoreCase = true)) return false
            val blob = described(voice)
            return blob.contains("male") && !blob.contains("female")
        }
        val males = voices.filter { englishMale(it) }
        val pool = if (males.isNotEmpty()) males else voices.filter {
            it.locale?.language.equals("en", ignoreCase = true)
        }
        return pool.maxWithOrNull(
            compareBy<Voice> { it.quality }
                .thenBy { if (it.isNetworkConnectionRequired) 0 else 1 }
                .thenBy { if (described(it).contains("deep") || described(it).contains("low")) 1 else 0 }
        )
    }

    private fun notifySpeechFinished(utteranceId: String?){
        val gen = utteranceId?.removePrefix("frontier-")?.toIntOrNull() ?: return
        if (gen != speechGen) return
        runOnUiThread{
            if (::web.isInitialized) web.evaluateJavascript("window.FrontierGuideNative?.onSpeechFinished()",null)
        }
    }

    override fun onResume() {
        super.onResume()
        if (ScreenCaptureService.active) tellJs("onScreenShareReady", ScreenCaptureService.currentSession.toString())
    }

    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){
        super.onActivityResult(requestCode,resultCode,data)
        when(requestCode){
            captureCode -> if (resultCode == Activity.RESULT_OK && data != null && pendingCaptureSession != 0 && pendingCaptureSession == ScreenCaptureService.acceptSession) {
                val i = Intent(this, ScreenCaptureService::class.java)
                    .putExtra("resultCode", resultCode)
                    .putExtra("data", data)
                    .putExtra("session", pendingCaptureSession)
                ContextCompat.startForegroundService(this, i)
            } else if (resultCode == Activity.RESULT_OK) {
                tellJs("onScreenShareStopped")
            } else {
                ScreenCaptureService.acceptSession = -1
                tellJs("onScreenShareDenied", "Screen share was cancelled.")
            }
            voiceCode -> if (intentVoiceGen != voiceGen) {
                // A Stop or a newer listen owns the microphone now.
            } else if (resultCode == Activity.RESULT_OK) {
                val spoken = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty()
                tellSpeechResult(spoken, intentVoiceGen)
            } else {
                tellJs("onSpeechError", "Voice question cancelled. Tap the mic when you are ready.")
            }
            fileChooserCode->{
                fileChooserCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode,data))
                fileChooserCallback=null
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        when (requestCode) {
            micCode -> if (granted) launchVoiceInput(pendingVoiceGen) else {
                pendingVoiceGen = null
                permissionDenied(
                    Manifest.permission.RECORD_AUDIO,
                    "Microphone access is needed for Talk. Tap the mic and choose Allow.",
                    "Microphone is blocked for Frontier Guide. Turn it on in Android Settings, then come back and tap the mic."
                )
            }
            cameraCode -> if (granted) tellJs("onCameraGranted") else {
                val blocked = !ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.CAMERA)
                tellJs(
                    "onCameraDenied",
                    if (blocked) "Camera is blocked for Frontier Guide. Turn it on in Android Settings, then tap Show Camera again."
                    else "Camera access is needed to show the TV. Tap Show Camera and choose Allow."
                )
                if (blocked) openAppSettings()
            }
            notificationCode -> if (granted) beginScreenShare() else {
                tellJs("onScreenShareDenied", "Allow notifications so screen share can stay running, then try again.")
            }
        }
    }

    override fun onDestroy(){
        try { unregisterReceiver(captureReceiver) } catch (_: IllegalArgumentException) {}
        coachOverlay.hide()
        cancelOwnedRecognizer()
        if (isFinishing) stopService(Intent(this, ScreenCaptureService::class.java))
        speechGen += 1
        speech?.stop()
        speech?.shutdown()
        speech=null
        if (::web.isInitialized) {
            web.stopLoading()
            (web.parent as? ViewGroup)?.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "FrontierGuide"
        private const val START_URL = "https://appassets.androidplatform.net/assets/web/index.html"
    }
}
