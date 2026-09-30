package com.frontierguide.app

import android.Manifest
import android.app.Activity
import android.content.*
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.util.Base64
import android.webkit.*
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File

class MainActivity: AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var projectionManager: MediaProjectionManager
    private val captureCode=9001

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        projectionManager=getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        requestNeededPermissions()
        web=WebView(this)
        setContentView(web)
        val loader=WebViewAssetLoader.Builder().addPathHandler("/assets/",WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.settings.javaScriptEnabled=true
        web.settings.domStorageEnabled=true
        web.settings.mediaPlaybackRequiresUserGesture=false
        web.settings.allowFileAccess=false
        web.settings.allowContentAccess=false
        web.settings.javaScriptCanOpenWindowsAutomatically=false
        web.settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
        web.settings.safeBrowsingEnabled=true
        web.webViewClient=object:WebViewClient(){
            override fun shouldInterceptRequest(view:WebView?,request:WebResourceRequest?)=request?.url?.let{loader.shouldInterceptRequest(it)}
            override fun shouldOverrideUrlLoading(view:WebView?,request:WebResourceRequest?):Boolean {
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
        }
        web.webChromeClient=object:WebChromeClient(){
            override fun onPermissionRequest(request:PermissionRequest?){
                runOnUiThread{
                    val origin=request?.origin
                    val trusted=origin?.scheme=="https" && origin?.host=="appassets.androidplatform.net"
                    val cameraOnly=request?.resources?.filter{it==PermissionRequest.RESOURCE_VIDEO_CAPTURE}?.toTypedArray() ?: emptyArray<String>()
                    if(trusted && cameraOnly.isNotEmpty())request?.grant(cameraOnly) else request?.deny()
                }
            }
        }
        web.addJavascriptInterface(Bridge(),"AndroidBridge")
        web.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")
    }

    inner class Bridge {
        @JavascriptInterface fun startScreenShare(){ runOnUiThread{ startActivityForResult(projectionManager.createScreenCaptureIntent(),captureCode) } }
        @JavascriptInterface fun stopScreenShare(){ stopService(Intent(this@MainActivity,ScreenCaptureService::class.java)) }
        @JavascriptInterface fun getLatestScreenDataUrl():String { val f=File(cacheDir,"latest_screen.jpg"); if(!f.exists())return ""; return "data:image/jpeg;base64,"+Base64.encodeToString(f.readBytes(),Base64.NO_WRAP) }
    }

    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){
        super.onActivityResult(requestCode,resultCode,data)
        if(requestCode==captureCode && resultCode==Activity.RESULT_OK && data!=null){
            val i=Intent(this,ScreenCaptureService::class.java).putExtra("resultCode",resultCode).putExtra("data",data)
            ContextCompat.startForegroundService(this,i)
            Toast.makeText(this,"Screen share active",Toast.LENGTH_SHORT).show()
        }
    }

    private fun requestNeededPermissions(){
        val need=mutableListOf<String>()
        for(p in listOf(Manifest.permission.CAMERA))if(ContextCompat.checkSelfPermission(this,p)!=PackageManager.PERMISSION_GRANTED)need+=p
        if(android.os.Build.VERSION.SDK_INT>=33 && ContextCompat.checkSelfPermission(this,Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)need+=Manifest.permission.POST_NOTIFICATIONS
        if(need.isNotEmpty())ActivityCompat.requestPermissions(this,need.toTypedArray(),44)
    }
}
