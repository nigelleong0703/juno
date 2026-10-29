      window.addEventListener("error", function () {
        window.startup?.report("renderer-error");
        document.getElementById("root").textContent = "Juno could not load. Please reopen the app. Your settings have been preserved.";
      });
      window.addEventListener("unhandledrejection", function () { window.startup?.report("renderer-error"); });
