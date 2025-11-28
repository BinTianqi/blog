---
title: "Dhizuku API 接入指南"
summary: "给你的DPC app接入Dhizuku API。本指南包含Binder wrapper、User service、Delegated scope三种Dhizuku API的使用方式。"
date: "2025-11-28"
tags: ["Android"]
---

因为[Dhizuku-API](https://github.com/iamr0s/Dhizuku-API)仓库没有也[不打算](https://github.com/iamr0s/Dhizuku-API/pull/4#issuecomment-2296001836)提供样例代码，想要接入Dhizuku API的开发者必须参考现有的开源项目和Dhizuku API的源代码，而很多项目的结构复杂，需要花大量的时间才能了解。所以我写了一个Dhizuku API接入指南。

本指南适合：会使用DevicePolicyManager API，想接入Dhizuku API的开发者。

## 添加依赖

`io.github.iamr0s:Dhizuku-API`

最新版本请前往[Maven central](https://central.sonatype.com/artifact/io.github.iamr0s/Dhizuku-API/versions)查看。

## 初始化

```kotlin
Dhizuku.init(context)
```

如果返回false，说明Dhizuku未安装或未激活，不要继续。

根据你的需要，选择Activity context或Application context。Dhizuku API提供了一个无需Context的`Dhizuku.init()`，不建议使用。

## 请求权限

```kotlin
if (Dhizuku.isPermissionGranted()) {
    // 权限已授予，下一步
} else {
    Dhizuku.requestPermission(object : DhizukuRequestPermissionListener() {
        override fun onRequestPermission(grantResult: Int) {
            if (grantResult == PackageManager.PERMISSION_GRANTED) {
                // 用户授予了权限，下一步
            } else {
                // 用户拒绝了请求
            }
        }
    })
}
```

## 使用API

### Binder wrapper

#### 创建IDevicePolicyManager接口

创建文件`YOUR_PROJECT/app/src/main/java/android/app/admin/IDevicePolicyManager.java`

```java
package android.app.admin;

import android.content.ComponentName;
import android.os.Binder;
import android.os.IBinder;
import android.os.IInterface;

import androidx.annotation.Keep;

@Keep
public interface IDevicePolicyManager extends IInterface {
    @Keep
    abstract class Stub extends Binder implements IDevicePolicyManager {
        public static IDevicePolicyManager asInterface(IBinder obj) {
            throw new UnsupportedOperationException();
        }
    }
}
```

如果你构建app时不启用shrink，你可以去掉@Keep注解。

#### 绕过隐藏API限制

添加[HiddenApiBypass](https://github.com/LSPosed/AndroidHiddenApiBypass)依赖： `org.lsposed.hiddenapibypass:hiddenapibypass`，最新版本请前往[Maven central](https://central.sonatype.com/artifact/org.lsposed.hiddenapibypass/hiddenapibypass/versions)查看。

建议在`Application.onCreate()`中调用此函数。

```kotlin
HiddenApiBypass.setHiddenApiExemptions("")
```

如果不绕过限制，在下一步的`getDeclaredField("mService")`时会抛出异常。

#### 获取DevicePolicyManager

```kotlin
fun binderWrapperDevicePolicyManager(appContext: Context): DevicePolicyManager? {
    try {
        val context = appContext.createPackageContext(Dhizuku.getOwnerComponent().packageName, Context.CONTEXT_IGNORE_SECURITY)
        val manager = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val field = manager.javaClass.getDeclaredField("mService")
        field.isAccessible = true
        val oldInterface = field[manager] as IDevicePolicyManager
        if (oldInterface is DhizukuBinderWrapper) return manager
        val oldBinder = oldInterface.asBinder()
        val newBinder = Dhizuku.binderWrapper(oldBinder)
        val newInterface = IDevicePolicyManager.Stub.asInterface(newBinder)
        field[manager] = newInterface
        return manager
    } catch (e: Exception) {
        e.printStackTrace()
    }
    return null
}
```

#### 调用DPM API

```kotlin
val dpm = binderWrapperDevicePolicyManager(context)
val component = Dhizuku.getOwnerComponent()
dpm.setApplicationHidden(component, "com.example.app", true) // 将com.example.app隐藏
```

### User Service

> Dhizuku的User service和Shizuku的User service十分接近。了解[Shizuku API](https://github.com/RikkaApps/Shizuku-API)将会对你使用Dhizuku的User service有帮助。

#### 启用AIDL

在app级的`build.gradle.kts`中启用AIDL

```kotlin
android {
    buildFeatures {
        aidl = true
    }
}
```

#### 创建AIDL文件

创建文件`YOUR_PROJECT/app/src/main/aidl/com/example/app/IDhizukuUserService.aidl`

```java
package com.example.app;

interface IDhizukuUserService {
    void testFunction();
}
```

构建app，会生成对应的java interface。

#### 创建ActivityThread

创建文件`YOUR_PROJECT/app/src/main/java/android/app/ActivityThread.java`

```java
package android.app;

public class ActivityThread {
    public static ActivityThread currentActivityThread() {
        throw new RuntimeException("STUB");
    }
    
    public Application getApplication() {
        throw new RuntimeException("STUB");
    }
}
```

#### 实现`IDhizukuUserService`

```kotlin
package com.example.app

class MyDhizukuUserService: IDhizukuUserService.Stub() {
    override fun testFunction() {
        val context = ActivityThread.currentActivityThread().application
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        dpm.lockNow()
    }
}
```

#### 定义`ServiceConnection`

```kotlin
class MyDhizukuServiceConnection: ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
        val service = IDhizukuUserService.Stub.asInterface(binder)
        service.testFunction() // 服务绑定后，调用testFunction()
    }

    override fun onServiceDisconnected(name: ComponentName?) {
        println("Disconnected")
    }
}
```

#### 绑定服务

```kotlin
Dhizuku.bindUserService(
    DhizukuUserServiceArgs(ComponentName(context, MyDhizukuUserService::class.java)), MyDhizukuServiceConnection()
)
```