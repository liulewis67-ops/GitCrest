use std::path::Path;

pub(crate) fn validate_paths(paths: &[String]) -> Result<(), std::io::Error> {
    if paths.is_empty()
        || paths.len() > 256
        || paths.iter().any(|path| {
            path.is_empty()
                || path.contains('\0')
                || path.len() > 4096
                || Path::new(path).is_absolute()
                || Path::new(path).components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::ParentDir | std::path::Component::RootDir
                    )
                })
        })
        || paths.iter().map(String::len).sum::<usize>() > 64 * 1024
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "The status path scope is invalid or too large",
        ));
    }
    Ok(())
}
