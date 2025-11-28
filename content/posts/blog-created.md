---
title: "创建我的blog了"
summary: "1年过去了，我终于建立了自己的blog"
date: "2025-11-27"
---

1年前，我在Termux里面编译nodogsplash，写了一篇文章记录下来过程，我当时是上传到了GitHub的Gists。我觉得我以后会写很多文章，Gists肯定是不合适的，所以就想搞一个blog。首先，排除CMS（Content management system，内容管理系统），我之前用过WordPress，里面的大部分功能我都用不上，而且我听说WP的bug很多，所以，我选择了SSG（Static site generator，静态站点生成器），在构建时把Markdown渲染成HTML。我没有选择之前做OwnDroidDocs的VitePress，因为它偏向docs，我选择了hugo。 我在Termux里面创建hugo站点，添加文章，添加主题，构建出了站点，但一直没有部署。

过了几个月，我重新创建了一个hugo站点，根据hugo的默认主题，创建了一个主题，非常简单，就是用css给页面布局。但也没有部署。

这个东西就一直搁置到现在。在这大半年时间里，我已经创建了一个网页，就是OwnDroid的网络日志和安全日志查看器，我又在犹豫：hugo很快，但有很多我用不到的功能，Go template很难用；写一个Vite插件，做SSG，可以比较方便地复用js和css文件，但太麻烦，而且构建慢。最后我选择了hugo，我把之前的样式改了一下，加上Material 3的配色，终于做成了blog站点。

这里讲一下我用hugo的时候踩的一个坑。

我在文章列表和文章页面需要用不同的css，一开始我在`layouts/partials/head/css.html`里面加上这一段代码，就是给文章页面用`single.css`，给列表页面用`list.css`

```html
{{- if .IsPage }}
  {{- with resources.Get "css/single.css" }}
    <link rel="stylesheet" href="{{ .RelPermalink }}">
  {{- end }}
{{- else }}
  {{- with resources.Get "css/list.css" }}
    <link rel="stylesheet" href="{{ .RelPermalink }}">
  {{- end }}
{{- end }}
```

访问hugo server中的文章页面，能加载`single.css`，后来我改了一下文章的内容，变成加载`list.css`了，我在浏览器里刷新页面，重启hugo server，清除hugo的构建输出目录，都不行。访问hugo server中别的页面，再回到文章页面，又没问题了。就是时不时有问题，十分离奇。

ChatGPT建议我加上这几条调试代码：

```text
{{ printf "IsPage = %v" .IsPage }}
{{ printf "Type = %v" .Type }}
{{ printf "Kind = %v" .Kind }}
```

我把它放到`layouts/partials/head/css.html`里面，在浏览器用DevTool查看内容，发现不管在哪个页面，这三个值都是一样的。 我用`hugo build`构建站点，也是一样的，说明不是hugo server的问题。

然后，我把这段代码放到了`layouts/_default/baseof.html`里面，现在每个页面有不同的值了。这说明`css.html`里面获取不到真实的页面属性。

我最后在`layouts/partials/head.html`里面发现了问题的根源：

```text
{{ partialCached "head/css.html" . }}
```

就是这个`partialCached`导致每个页面的`.IsPage`, `.Type`等属性一样，`css.html`中无法获取到正确的页面属性，所以无法加载列表和文章页面对应的css。

把`partialCached`改成`partial`，解决问题。
