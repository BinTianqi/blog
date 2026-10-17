---
title: "绕过激活 device owner 时的账号限制"
summary: "Android 上，激活 device owner 时，设备上不能有账号，但是这个限制可以被绕过"
tags: ["Android"]
date: "2026-10-17"
---

Android 上，正常情况下，激活 device owner 时，设备上不能有账号，不过并非完全不能有，大部分情况下，把持有那个账号的对应 app 禁用了就可以解决。

前段时间，有人给我的项目 [OwnDroid](https://github.com/BinTianqi/OwnDroid) 开了一个 issue ([#371](https://github.com/BinTianqi/OwnDroid/issues/371)) ，说有办法绕过激活 device owner 时的账号限制。

他给了一个 [XDA forums 的链接](https://xdaforums.com/t/how-i-got-device-owner-without-factory-reset.4745834/#post-90768446)。打开链接，附件里有一个 shell 脚本和一个 jar 文件，jar 文件后面再说，先看它的脚本（仅截取了关键部分）：

```shell
HELPER="${1:-}" # jar 文件的路径，通过命令行参数传入
COMPONENT="com.rosan.dhizuku/.server.DhizukuDAReceiver" # Dhizuku 的 DeviceAdminReceiver
BRIDGE=com.shift.research.SetupStateBridge # jar 里的类名

refresh_setup_cache() { # 执行 jar 里的代码
  CLASSPATH="$HELPER" app_process /system/bin "$BRIDGE" force-update 0
}

# 关键代码
settings put secure user_setup_complete 0
refresh_setup_cache

dpm set-device-owner "$COMPONENT"

settings put secure user_setup_complete 1
refresh_setup_cache
```

我可以把这个 XDA forums 的链接直接放在项目的 README.md 里，但对于用户来说，这十分不友好，大部分 OwnDroid 用户应该是用 Shizuku 激活 OwnDroid 的，而他们启动 Shizuku 的方式应该是无线调试，咱不能指望他们有电脑、会下载安装 adb 、会执行 shell 命令。

## 修改设置

既然大部分用户通过 Shizuku 或 root 激活 OwnDroid ，那我们在 OwnDroid 里自己实现修改设置就行了。

最简单的方式就是，在 Shizuku 的 user service 里，直接用`Runtime.getRuntime().exec()`执行那个脚本。
它好像只能执行单行命令，不支持多行命令和 bash 语法，但最多也就是包一层`sh -c xxx.sh`的事。

但这么做不优雅。Shizuku 设计出来就是为了让开发者直接在 Java/Kotlin 代码中使用 Binder 和 system_server 通信，而不是 shell 命令。

（这部分是踩坑记录，最后还是用了 shell 命令，如果不感兴趣，可以直接跳到[更新状态](#更新状态)部分）

### Settings

Android SDK 提供了`Settings` API ，先试试它。

用反射获取 context ：

```kotlin
fun getContextUsingReflection(): Context {
    return Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication").invoke(null) as Context
}
```

读取设置：

```kotlin
val context = getContextUsingReflection()
Settings.Secure.getString(context.contentResolver, "user_setup_complete")
```

报错如下：

```text
java.lang.SecurityException: Given calling package android does not match caller's uid 2000
```

照着网上的说法，修改代码：

```kotlin
val ci = Binder.clearCallingIdentity()
Settings.Secure.getString(context.contentResolver, "user_setup_complete")
Binder.restoreCallingIdentity(ci)
```

没用，仍然报错。

看看 [Shizuku-API](https://github.com/RikkaApps/Shizuku-API) 的 example 吧。找到 [UserService.java](https://github.com/RikkaApps/Shizuku-API/blob/master/demo/src/main/java/rikka/shizuku/demo/service/UserService.java) ：

```java
public class UserService extends IUserService.Stub {
    public UserService(Context context) {
        Log.i("UserService", "constructor with Context: context=" + context.toString());
    }
}
```

发现它有一个带 context 的 constructor ，那试试 Shizuku 给的 context ：

```kotlin
class ShizukuService(): IUserService.Stub() {
    lateinit var context: Context
    constructor(ctx: Context) : this() {
        context = ctx
    }
}
```

也没用，获取设置时仍然会报错。

### settings 命令

adb shell 里面也没有正常 context ，那`settings`命令是怎么读取和修改设置的呢？

我在 Android 源代码里找到了 [SettingsService.java](https://cs.android.com/android/platform/superproject/+/android-latest-release:frameworks/base/packages/SettingsProvider/src/com/android/providers/settings/SettingsService.java) 。

```java
final public class SettingsService extends Binder {
    @Override
    public void onShellCommand(FileDescriptor in, FileDescriptor out, FileDescriptor err,
            String[] args, ShellCallback callback, ResultReceiver resultReceiver) {
        (new MyShellCommand(mProvider, false)).exec(
                this, in, out, err, args, callback, resultReceiver);
    }
    // ...
}
```

我本以为是`settings`命令能通过某种方式获取到正常的`Context`，然后获取到`ContentResolver`，再通过`Settings` API 修改设置，没想到，它直接把命令行参数转发给 system_server ，在服务端做参数解析，在服务端修改设置。

这本质上还是 shell 命令啊，只不过是不用创建进程，并没有优雅多少，而且，Android 6 甚至没有这个 service 。

### Context

回到开始。

`ContentResolver`是怎么知道包名和 UID 不匹配的呢？应该是`Context`的问题。那我想办法获取`com.android.shell`的 context 应该就行了。

```kotlin
val shellContext = getContextUsingReflection()
    .createPackageContext("com.android.shell", 0)
```

结果还是同样的报错。

看看 context 里的 package name ：

```kotlin
Log.d(TAG, "package name: ${shellContext.packageName}")
Log.d(TAG, "op package name: ${shellContext.opPackageName}")
```

前者是`com.android.shell`，但后者仍然是`android`，问题应该出在这里。

我去看了 [ContextImpl.java] ，虽然我可以手动构建一个`opPackageName`为`com.android.shell`的 context ，但这么做要用到一堆反射，更不优雅，还不如直接用`Runtime.getRuntime().exec()`。

### 看回 stacktrace

```text
java.lang.SecurityException: Given calling package android does not match caller's uid 2000
    ...
    at android.app.IActivityManager$Stub$Proxy.getContentProvider(IActivityManager.java:6397)
    at android.app.ActivityThread.acquireProvider(ActivityThread.java:8191)
    at android.app.ContextImpl$ApplicationContentResolver.acquireProvider(ContextImpl.java:3847)
    at android.content.ContentResolver.acquireProvider(ContentResolver.java:2528)
    at android.provider.Settings$ContentProviderHolder.getProvider(Settings.java:3449)
    at android.provider.Settings$NameValueCache.getStringForUser(Settings.java:3675)
    at android.provider.Settings$Secure.getStringForUser(Settings.java:7219)
    at android.provider.Settings$Secure.getString(Settings.java:7185)
    ...
```

找到 [ActivityThread.java](https://cs.android.com/android/platform/superproject/+/android-latest-release:frameworks/base/core/java/android/app/ActivityThread.java) ：

```java
public final class ActivityThread extends ClientTransactionHandler implements ActivityThreadInternal {
    @UnsupportedAppUsage
    public IContentProvider acquireProvider(Context c, String auth, int userId, boolean stable) {
        // ...
        ContentProviderHolder holder;
        holder = ActivityManager.getService().getContentProvider(
                getApplicationThread(), c.getOpPackageName(), auth, userId, stable);
        // ...
    }
}
```

再看回`ContextImpl`的`getOpPackageName()`：

```java
class ContextImpl extends Context {
    private @NonNull AttributionSource mAttributionSource;
    
    @Override
    public String getOpPackageName() {
        return mAttributionSource.getPackageName();
    }
}
```

如果硬要去改`opPackageName`，那就得改`mAttributionSource`，不仅要用到一堆反射，而且在不同 Android 版本上还有可能不一样，不优雅。

那构造一个`ContextImpl`呢？

```java
static ContextImpl createAppContext(ActivityThread mainThread, LoadedApk packageInfo,
        String opPackageName) {
    // ...
    ContextImpl context = new ContextImpl(null, mainThread, packageInfo,
            ContextParams.EMPTY, null, null, null, null, null, 0, null, opPackageName,
            DEVICE_ID_DEFAULT, false);
    // ...
    return context;
}
```

`ActivityThread`很好拿，反射就行，`LoadedApk`也不难，可以从现有的`context`里面获取。但，我觉得这还是太复杂了。

### ContentProvider

在 Android 6 那时候，还没有`SettingsService`，那 shell 里的`settings`命令是怎么获取设置的？

找到 [SettingsCmd.java](https://cs.android.com/android/platform/superproject/+/android-6.0.1_r1:frameworks/base/cmds/settings/src/com/android/commands/settings/SettingsCmd.java) 。

```java
public final class SettingsCmd {
    public void run() {
        // ...
        IActivityManager activityManager = ActivityManagerNative.getDefault();
        IContentProvider provider = null;
        IBinder token = new Binder();
        ContentProviderHolder holder = activityManager.getContentProviderExternal(
                "settings", UserHandle.USER_OWNER, token);
        provider = holder.provider;
        // ...
    }

    String getForUser(IContentProvider provider, int userHandle,
            final String table, final String key) {
        final String callGetCommand; // 例如 Settings.CALL_METHOD_GET_SYSTEM
        // ...
        Bundle arg = new Bundle();
        arg.putInt(Settings.CALL_METHOD_USER_KEY, userHandle);
        Bundle b = provider.call(resolveCallingPackage(), callGetCommand, key, arg);
        if (b != null) {
            result = b.getPairValue();
        }
    }

    public static String resolveCallingPackage() {
        switch (android.os.Process.myUid()) {
            case Process.ROOT_UID: {
                return "root";
            }
            case Process.SHELL_UID: {
                return "com.android.shell";
            }
            default: {
                return null;
            }
        }
    }
}
```

它是直接通过`ContentProvider`查询设置的，我也试试。

`ActivityManagerNative`在新的安卓上已经弃用，用`ServiceManager.getService()`就行。

`IActivityManager`需要反射，不方便，看看`Settings`是怎么获取`ContentProvider`的：

```java
String AUTHORITY = "settings";
Uri CONTENT_URI = Uri.parse("content://" + AUTHORITY + "/global");
ContentProviderHolder mProviderHolder = new ContentProviderHolder(CONTENT_URI);
IContentProvider cp = mProviderHolder.getProvider(contentResolver);
```

绕了一圈，还是要用到`ContentResolver`吗？我本以为像 SettingsCmd.java 那样，用`ContentProviderHolder.provider`就可以，但，`Settings`里的`ContentProviderHolder`是`Settings.ContentProviderHolder`，并非 SettingsCmd.java 用到的`android.app.ContentProviderHolder`。

`IActivityManager.getContentProviderExternal()`在不同安卓版本上有不同的参数，麻烦。

### Shell 命令

现在，shell 命令反倒是成了最优雅的做法。在 Shizuku 的 UserService 里：

```kotlin
Runtime.getRuntime().exec("settings put secure user_setup_complete 0")
```

## 更新状态

用 JADX 反编译那个 jar 文件。

（已简化代码）

```java
package com.shift.research;

public final class SetupStateBridge {
    /* 命令行参数为 force-update 和 0 */
    public static void main(String[] strArr) throws Exception {
        Object devicePolicyService = getDevicePolicyService();
        Method findForceUpdateMethod = Class.forName("android.app.admin.IDevicePolicyManager")
            .getMethod("forceUpdateUserSetupComplete", Integer.TYPE);
        int parseInt = Integer.parseInt(strArr[1]);
        invoke(findForceUpdateMethod, devicePolicyService, Integer.valueOf(parseInt));
    }

    private static Object getDevicePolicyService() throws Exception {
        Class<?> cls = Class.forName("android.os.ServiceManager");
        Class<?> cls2 = Class.forName("android.os.IBinder");
        // 通过 ServiceManager 获取 DevicePolicyManagerService 的 Binder
        Object invoke = cls.getMethod("getService", String.class).invoke(null, "device_policy");
        Object invoke2 = Class.forName("android.app.admin.IDevicePolicyManager$Stub")
            .getMethod("asInterface", cls2).invoke(null, invoke);
        return invoke2;
    }

    private static void invoke(Method method, Object obj, Object... objArr) throws Exception {
        method.invoke(obj, objArr);
    }
}
```

简单来说，就是调用了 [DevicePolicyManagerService](https://cs.android.com/android/platform/superproject/+/android-latest-release:frameworks/base/services/devicepolicy/java/com/android/server/devicepolicy/DevicePolicyManagerService.java) 的`forceUpdateUserSetupComplete()`来更新它内部的状态。

## 最终代码

（已简化）

```kotlin
@Keep
class ActivationService : IActivationService.Stub() {
    override fun execute(command: String): Bundle? {
        val bundle = Bundle()
        val process = Runtime.getRuntime().exec(command)
        // 此处省略把 stdout 和 stderr 放到 Bundle 里的代码
        return bundle
    }

    override fun activateDeviceOwner(): Bundle? {
        var bypassed = false
        // 那个 shell 脚本会在修改设置前检查 user_setup_complete ，只不过上面我把它省略了
        val getProc = Runtime.getRuntime().exec("settings get secure user_setup_complete")
        val getOutput = getProc.inputStream.readBytes().decodeToString()
        if (getOutput == "1" || getOutput == "1\n") {
            val putProc = Runtime.getRuntime().exec("settings put secure user_setup_complete 0")
            val exitCode = putProc.waitFor()
            Log.d(TAG, "Setting user_setup_complete, exit code $exitCode")
            bypassed = exitCode == 0
        } else {
            // 未知情况，不尝试绕过设置
            Log.w(TAG, "Get user_setup_complete, expected 1, actual $getOutput")
        }

        if (bypassed) forceUpdateSetupComplete()

        val setOwnerResult = execute("dpm set-device-owner com.bintianqi.owndroid/.Receiver")

        if (bypassed) { // 还原设置
            val putProc = Runtime.getRuntime().exec("settings put secure user_setup_complete 1")
            putProc.waitFor()
            forceUpdateSetupComplete()
        }
        return setOwnerResult
    }

    private fun forceUpdateSetupComplete() {
        // 更新 DevicePolicyManagerService 内部状态
        try {
            val binder = ServiceManager.getService(Context.DEVICE_POLICY_SERVICE)
            val dpm = IDevicePolicyManager.Stub.asInterface(binder)
            if (Build.VERSION.SDK_INT >= 31) {
                dpm.forceUpdateUserSetupComplete(0)
            } else {
                dpm.forceUpdateUserSetupComplete()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to force update DPMS state", e)
        }
    }

    companion object {
        const val TAG = "ActivationService"
    }
}
```

`ServiceManager`和`IDevicePolicyManager`都是隐藏 API ，我自己定义了 interface 。

```java
package android.app.admin;

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

    void forceUpdateUserSetupComplete();

    void forceUpdateUserSetupComplete(int userId); // Android 12 及以上
}
```

```java
package android.os;

import androidx.annotation.Keep;

@Keep
public interface ServiceManager {
    static IBinder getService(String name) {
        throw new UnsupportedOperationException();
    }
}
```

测试，能在有账号的情况下激活 device owner。

顺手给 Dhizuku 开一个 issue ([#347](https://github.com/iamr0s/Dhizuku/issues/347))，把这个方法告诉它的开发者。

完成！
