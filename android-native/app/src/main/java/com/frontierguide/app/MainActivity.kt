package com.frontierguide.app

import android.Manifest
import android.app.Activity
import android.content.*
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.speech.RecognizerIntent
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
    private var fileChooserCallback:ValueCallback<Array<Uri>>?=null
    private var speech: TextToSpeech?=null
    private var speechReady=false
    private var rendererReloads=0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        projectionManager=getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        requestNeededPermissions()
        loader=WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
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
                        override fun onError(utteranceId:String?){ notifySpeechFinished() }
                        override fun onDone(utteranceId:String?){ notifySpeechFinished() }
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
        @JavascriptInterface fun startScreenShare(){ runOnUiThread{ startActivityForResult(projectionManager.createScreenCaptureIntent(),captureCode) } }
        @JavascriptInterface fun stopScreenShare(){ stopService(Intent(this@MainActivity,ScreenCaptureService::class.java)) }
        @JavascriptInterface fun getLatestScreenDataUrl():String { val f=File(cacheDir,"latest_screen.jpg"); if(!f.exists())return ""; return "data:image/jpeg;base64,"+Base64.encodeToString(f.readBytes(),Base64.NO_WRAP) }
        @JavascriptInterface fun startVoiceInput(){ runOnUiThread{ launchVoiceInput() } }
        @JavascriptInterface fun speak(text:String,rate:Double,pitch:Double){
            runOnUiThread{
                if(!speechReady){
                    web.evaluateJavascript("window.FrontierGuideNative?.onSpeechError('Android voice is still starting. Tap the mic again.')",null)
                    return@runOnUiThread
                }
                speech?.setSpeechRate(rate.toFloat().coerceIn(.65f,1.35f))
                speech?.setPitch(pitch.toFloat().coerceIn(.7f,1.25f))
                speech?.speak(text.take(5_000),TextToSpeech.QUEUE_FLUSH,null,"frontier-response")
            }
        }
        @JavascriptInterface fun stopSpeaking(){ runOnUiThread{ speech?.stop() } }
    }

    private fun launchVoiceInput(){
        if(ContextCompat.checkSelfPermission(this,Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){
            ActivityCompat.requestPermissions(this,arrayOf(Manifest.permission.RECORD_AUDIO),45)
            web.evaluateJavascript("window.FrontierGuideNative?.onSpeechError('Allow microphone access, then tap the mic again.')",null)
            return
        }
        try{
            val intent=Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE,Locale.US.toLanguageTag())
                .putExtra(RecognizerIntent.EXTRA_PROMPT,"Ask Frontier Guide")
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS,1)
            startActivityForResult(intent,voiceCode)
        }catch(_:ActivityNotFoundException){
            web.evaluateJavascript("window.FrontierGuideNative?.onSpeechError('No speech recognition service is installed on this phone.')",null)
        }
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

    private fun notifySpeechFinished(){
        runOnUiThread{
            if (::web.isInitialized) web.evaluateJavascript("window.FrontierGuideNative?.onSpeechFinished()",null)
        }
    }

    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){
        super.onActivityResult(requestCode,resultCode,data)
        when(requestCode){
            captureCode->if(resultCode==Activity.RESULT_OK && data!=null){
                val i=Intent(this,ScreenCaptureService::class.java).putExtra("resultCode",resultCode).putExtra("data",data)
                ContextCompat.startForegroundService(this,i)
                Toast.makeText(this,"Screen share active",Toast.LENGTH_SHORT).show()
            }
            voiceCode->if(resultCode==Activity.RESULT_OK){
                val results=data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
                val spoken=results?.firstOrNull().orEmpty()
                web.evaluateJavascript("window.FrontierGuideNative?.onSpeechResult(${JSONObject.quote(spoken)})",null)
            }else{
                web.evaluateJavascript("window.FrontierGuideNative?.onSpeechError('Voice question cancelled. Tap the mic when you are ready.')",null)
            }
            fileChooserCode->{
                fileChooserCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode,data))
                fileChooserCallback=null
            }
        }
    }

    private fun requestNeededPermissions(){
        val need=mutableListOf<String>()
        for(p in listOf(Manifest.permission.CAMERA,Manifest.permission.RECORD_AUDIO))if(ContextCompat.checkSelfPermission(this,p)!=PackageManager.PERMISSION_GRANTED)need+=p
        if(android.os.Build.VERSION.SDK_INT>=33 && ContextCompat.checkSelfPermission(this,Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)need+=Manifest.permission.POST_NOTIFICATIONS
        if(need.isNotEmpty())ActivityCompat.requestPermissions(this,need.toTypedArray(),44)
    }

    override fun onDestroy(){
        if (isFinishing) stopService(Intent(this, ScreenCaptureService::class.java))
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
