# Custom execution platform enabling remote-cache-only (no remote execution).
# Mirrors prelude/platforms/defs.bzl's execution_platform but sets
# remote_cache_enabled=True and allow_cache_uploads=True in CommandExecutorConfig.
# The bundled prelude's execution_platform rule hard-codes remote_enabled=False
# and does not expose remote_cache_enabled, so we define our own.

load("@prelude//cfg/exec_platform:marker.bzl", "get_exec_platform_marker")

def _remote_cache_execution_platform_impl(ctx: AnalysisContext) -> list[Provider]:
    constraints = dict()
    constraints.update(ctx.attrs.cpu_configuration[ConfigurationInfo].constraints)
    constraints.update(ctx.attrs.os_configuration[ConfigurationInfo].constraints)
    cfg = ConfigurationInfo(constraints = constraints, values = {})

    name = ctx.label.raw_target()
    platform = ExecutionPlatformInfo(
        label = name,
        configuration = cfg,
        executor_config = CommandExecutorConfig(
            local_enabled = True,
            remote_enabled = False,
            remote_cache_enabled = True,
            allow_cache_uploads = True,
            use_windows_path_separators = ctx.attrs.use_windows_path_separators,
        ),
    )

    return [
        DefaultInfo(),
        platform,
        PlatformInfo(label = str(name), configuration = cfg),
        ExecutionPlatformRegistrationInfo(
            platforms = [platform],
            exec_marker_constraint = get_exec_platform_marker(),
        ),
    ]

remote_cache_execution_platform = rule(
    impl = _remote_cache_execution_platform_impl,
    attrs = {
        "cpu_configuration": attrs.dep(providers = [ConfigurationInfo]),
        "os_configuration": attrs.dep(providers = [ConfigurationInfo]),
        "use_windows_path_separators": attrs.bool(),
    },
)
